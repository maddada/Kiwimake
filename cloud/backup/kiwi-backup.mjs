#!/usr/bin/env node
// Kiwimake Cloud's own daily backup (docs/CLOUD.md section 4, "Backups on Convex Starter").
// Convex Starter has no periodic backups ("Periodic backups require a Convex Pro plan"; a manual
// backup is "stored for 7 days", at most two per deployment), so this exports the production
// deployment with Convex's own `npx convex export` (the same ZIP a backup is, and what
// `npx convex import` restores), encrypts it to our backup public key, keeps it as a release asset
// in a PRIVATE GitHub repo, and deletes copies older than the retention.
//
// Self-contained on purpose (Node 22+ and the convex package, nothing else), so the private
// backups repo can carry a copy of this file with its scheduled workflow (github-workflow.yml).
//
//   node kiwi-backup.mjs keygen --out <private key file>   prints the public key (safe to share)
//   node kiwi-backup.mjs run                                 export, encrypt, upload, prune
//   node kiwi-backup.mjs restore --key <file> --in <backup.kwb> --out <snapshot.zip>
//
// run reads (never from a command line, never printed): CONVEX_DEPLOY_KEY (a production deploy
// key allowed to export; dev keys are refused unless BACKUP_ALLOW_DEV=1), BACKUP_PUBLIC_KEY,
// BACKUP_REPO (owner/name, private), GITHUB_TOKEN; and BACKUP_KEEP_DAYS (default 30),
// BACKUP_MIN_KEEP (default 7), BACKUP_INCLUDE_FILES=1 to add file storage (APKs, icons; off by
// default: builds can be made again from each app's GitHub repo), CONVEX_CLI (the convex bin).
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RETENTION_DAYS = 30;
export const MIN_KEEP = 7;
const MAGIC = Buffer.from('KWBK1\n');
const CHUNK = 1 << 20;
const TAG_PREFIX = 'backup-';

// ---------- keys (X25519)

const PUB_PREFIX = 'KWBK-PUBLIC-1:';
const PRIV_PREFIX = 'KWBK-PRIVATE-1:';

export function keygen() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return {
    publicText: `${PUB_PREFIX}${pub.toString('base64url')}`,
    privateText: `${PRIV_PREFIX}${privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')}\n`,
  };
}

function publicKeyOf(text) {
  const t = String(text ?? '').trim();
  if (!t.startsWith(PUB_PREFIX)) throw new Error(`BACKUP_PUBLIC_KEY must start with ${PUB_PREFIX}`);
  const raw = Buffer.from(t.slice(PUB_PREFIX.length), 'base64url');
  if (raw.length !== 32) throw new Error('BACKUP_PUBLIC_KEY is not an X25519 key');
  return { key: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' }), raw };
}

function privateKeyOf(text) {
  const t = String(text ?? '').trim();
  if (!t.startsWith(PRIV_PREFIX)) throw new Error(`the key file must start with ${PRIV_PREFIX}`);
  return crypto.createPrivateKey({ key: Buffer.from(t.slice(PRIV_PREFIX.length), 'base64url'), format: 'der', type: 'pkcs8' });
}

const kidOf = (raw) => crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);

function dataKey(shared, salt, header) {
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.concat([Buffer.from('kiwimake backup v1\n'), header]), 32));
}

function nonce(i) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(i), 4);
  return n;
}

// ---------- encryption: a header, then 1 MiB AES-256-GCM chunks; the last is marked final, so a
// cut-off or reordered file never decrypts.

export function encryptFile(inPath, outPath, publicText, meta = {}) {
  const { key, raw } = publicKeyOf(publicText);
  const eph = crypto.generateKeyPairSync('x25519');
  const header = Buffer.from(`${JSON.stringify({
    v: 1,
    kid: kidOf(raw),
    epk: Buffer.from(eph.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64url'),
    salt: crypto.randomBytes(16).toString('base64url'),
    chunk: CHUNK,
    ...meta,
  })}\n`);
  const h = JSON.parse(header.toString());
  const k = dataKey(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: key }), Buffer.from(h.salt, 'base64url'), header);
  const src = fs.openSync(inPath, 'r');
  const dst = fs.openSync(outPath, 'w', 0o600);
  try {
    fs.writeSync(dst, MAGIC);
    fs.writeSync(dst, header);
    const size = fs.fstatSync(src).size;
    const buf = Buffer.alloc(CHUNK);
    let offset = 0;
    let i = 0;
    do {
      const n = fs.readSync(src, buf, 0, CHUNK, offset);
      offset += n;
      const final = offset >= size;
      const c = crypto.createCipheriv('aes-256-gcm', k, nonce(i));
      c.setAAD(Buffer.concat([header, Buffer.from([final ? 1 : 0])]));
      const body = Buffer.concat([c.update(buf.subarray(0, n)), c.final(), c.getAuthTag()]);
      const len = Buffer.alloc(5);
      len.writeUInt8(final ? 1 : 0, 0);
      len.writeUInt32BE(body.length, 1);
      fs.writeSync(dst, len);
      fs.writeSync(dst, body);
      i++;
      if (final) break;
    } while (true);
  } finally {
    fs.closeSync(src);
    fs.closeSync(dst);
  }
}

export function decryptFile(inPath, outPath, privateText) {
  const priv = privateKeyOf(privateText);
  const all = fs.readFileSync(inPath);
  if (!all.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a Kiwimake backup');
  const end = all.indexOf(0x0a, MAGIC.length);
  const header = all.subarray(MAGIC.length, end + 1);
  const h = JSON.parse(header.toString());
  if (h.v !== 1) throw new Error(`unknown backup version ${h.v}`);
  const ourPub = Buffer.from(crypto.createPublicKey(priv).export({ format: 'jwk' }).x, 'base64url');
  if (kidOf(ourPub) !== h.kid) throw new Error('this backup was made for another backup key');
  const epk = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: h.epk }, format: 'jwk' });
  const k = dataKey(crypto.diffieHellman({ privateKey: priv, publicKey: epk }), Buffer.from(h.salt, 'base64url'), header);
  const out = fs.openSync(outPath, 'w', 0o600);
  try {
    let at = end + 1;
    let i = 0;
    for (;;) {
      if (at + 5 > all.length) throw new Error('the backup is cut off');
      const final = all.readUInt8(at) === 1;
      const len = all.readUInt32BE(at + 1);
      const body = all.subarray(at + 5, at + 5 + len);
      if (body.length !== len || len < 16) throw new Error('the backup is cut off');
      const d = crypto.createDecipheriv('aes-256-gcm', k, nonce(i));
      d.setAAD(Buffer.concat([header, Buffer.from([final ? 1 : 0])]));
      d.setAuthTag(body.subarray(len - 16));
      fs.writeSync(out, Buffer.concat([d.update(body.subarray(0, len - 16)), d.final()]));
      at += 5 + len;
      i++;
      if (final) break;
    }
    if (at !== all.length) throw new Error('the backup has data after its end');
  } finally {
    fs.closeSync(out);
  }
  return h;
}

// ---------- checking the export: a ZIP whose central directory lists the tables

export function zipTables(zipPath) {
  const b = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('the export is not a ZIP file');
  const count = b.readUInt16LE(eocd + 10);
  let at = b.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(at) !== 0x02014b50) throw new Error('the export ZIP is damaged');
    const nameLen = b.readUInt16LE(at + 28);
    names.push(b.subarray(at + 46, at + 46 + nameLen).toString('utf8'));
    at += 46 + nameLen + b.readUInt16LE(at + 30) + b.readUInt16LE(at + 32);
  }
  return [...new Set(names.filter((n) => n.endsWith('/documents.jsonl')).map((n) => n.split('/')[0]))].sort();
}

// ---------- retention

/** Which backups to delete: older than keepDays, but never the newest minKeep. */
export function planPrune(backups, now = Date.now(), keepDays = RETENTION_DAYS, minKeep = MIN_KEEP) {
  const newest = [...backups].sort((a, b) => b.at - a.at);
  return newest.slice(minKeep).filter((b) => now - b.at > keepDays * 86_400_000);
}

export const tagFor = (date) => `${TAG_PREFIX}${date.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;

// ---------- the private repo's releases (GitHub REST API)

export class GithubReleases {
  constructor({ repo, token, api = 'https://api.github.com', uploads = 'https://uploads.github.com' }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo ?? ''))) throw new Error('BACKUP_REPO must be owner/name');
    if (!token) throw new Error('GITHUB_TOKEN is missing');
    Object.assign(this, { repo, token, api, uploads });
  }

  async call(method, url, body, type = 'application/json') {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'kiwimake-backup', ...(body ? { 'Content-Type': type } : {}) },
      ...(body ? { body } : {}),
    });
    if (!res.ok && res.status !== 404) throw new Error(`GitHub ${method} ${new URL(url).pathname}: ${res.status}`);
    return res.status === 204 || res.status === 404 ? null : res.json();
  }

  /** Refuses a public repo: the backups must never be readable by anyone else. */
  async checkPrivate() {
    const r = await this.call('GET', `${this.api}/repos/${this.repo}`);
    if (!r) throw new Error(`no repo ${this.repo} for this token`);
    if (!r.private) throw new Error(`${this.repo} is public: backups go only to a private repo`);
  }

  async list() {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const rows = (await this.call('GET', `${this.api}/repos/${this.repo}/releases?per_page=100&page=${page}`)) ?? [];
      for (const r of rows) if (String(r.tag_name).startsWith(TAG_PREFIX)) out.push({ id: r.id, tag: r.tag_name, at: Date.parse(r.created_at) });
      if (rows.length < 100) break;
    }
    return out;
  }

  async upload(tag, filePath, notes) {
    const rel = await this.call('POST', `${this.api}/repos/${this.repo}/releases`, JSON.stringify({ tag_name: tag, name: tag, body: notes, draft: false, prerelease: false }));
    const name = path.basename(filePath);
    await this.call('POST', `${this.uploads}/repos/${this.repo}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`, fs.readFileSync(filePath), 'application/octet-stream');
    return rel.id;
  }

  async remove(backup) {
    await this.call('DELETE', `${this.api}/repos/${this.repo}/releases/${backup.id}`);
    await this.call('DELETE', `${this.api}/repos/${this.repo}/git/refs/tags/${backup.tag}`);
  }
}

// ---------- run

function convexExport(env, out, includeFiles) {
  const cli = env.CONVEX_CLI || path.join(process.cwd(), 'node_modules', 'convex', 'bin', 'main.js');
  const args = [cli, 'export', '--path', out, ...(includeFiles ? ['--include-file-storage'] : [])];
  // The deploy key goes to the CLI through its environment only.
  const r = spawnSync(process.execPath, args, { env: { PATH: env.PATH ?? process.env.PATH, HOME: env.HOME ?? os.homedir(), CONVEX_DEPLOY_KEY: env.CONVEX_DEPLOY_KEY }, encoding: 'utf8', timeout: 25 * 60_000 });
  const hide = (s) => String(s ?? '').replace(/\b(dev|prod|preview|project):[^\s'"]+/g, '[deploy key]');
  if (r.status !== 0) throw new Error(`convex export failed: ${hide(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
}

export async function run(env = process.env, deps = {}) {
  const log = deps.log ?? ((...m) => console.log(new Date().toISOString(), ...m));
  const key = String(env.CONVEX_DEPLOY_KEY ?? '');
  if (!/^(prod|dev):/.test(key)) throw new Error('CONVEX_DEPLOY_KEY must be a Convex deploy key');
  if (key.startsWith('dev:') && env.BACKUP_ALLOW_DEV !== '1') throw new Error('this is a dev deploy key; production backups need a production key');
  const deployment = key.slice(key.indexOf(':') + 1).split('|')[0].replace(/[^a-z0-9-]/g, '').slice(0, 60) || 'deployment';
  publicKeyOf(env.BACKUP_PUBLIC_KEY);
  const keepDays = Number(env.BACKUP_KEEP_DAYS ?? RETENTION_DAYS);
  const minKeep = Number(env.BACKUP_MIN_KEEP ?? MIN_KEEP);
  if (!(keepDays >= 1) || !(minKeep >= 1)) throw new Error('BACKUP_KEEP_DAYS and BACKUP_MIN_KEEP must be 1 or more');
  const store = deps.store ?? new GithubReleases({ repo: env.BACKUP_REPO, token: env.GITHUB_TOKEN });
  if (store.checkPrivate) await store.checkPrivate();

  const now = deps.now?.() ?? new Date();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-backup-'));
  try {
    const zip = path.join(dir, 'snapshot.zip');
    const t0 = Date.now();
    (deps.exportTo ?? ((out) => convexExport(env, out, env.BACKUP_INCLUDE_FILES === '1')))(zip);
    const tables = zipTables(zip);
    // An export without the account and key tables is not a backup worth keeping.
    for (const must of ['users', 'apps', 'keys']) if (!tables.includes(must)) throw new Error(`the export has no ${must} table`);
    const tag = tagFor(now);
    const enc = path.join(dir, `kiwimake-${deployment}-${tag.slice(TAG_PREFIX.length)}.kwb`);
    encryptFile(zip, enc, env.BACKUP_PUBLIC_KEY, { deployment, createdAt: now.toISOString(), tables: tables.length });
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(enc)).digest('hex');
    const size = fs.statSync(enc).size;
    fs.rmSync(zip);
    await store.upload(tag, enc, `Encrypted Convex export of ${deployment}, ${tables.length} tables, ${size} bytes, sha256 ${sha256}. Restore: node kiwi-backup.mjs restore --key <private key> --in <file> --out snapshot.zip, then npx convex import --replace-all snapshot.zip.`);
    log(`backup ${tag}: ${tables.length} tables, ${size} bytes encrypted, in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const gone = planPrune(await store.list(), now.getTime(), keepDays, minKeep);
    for (const b of gone) await store.remove(b);
    if (gone.length) log(`removed ${gone.length} backup(s) older than ${keepDays} days`);
    return { tag, tables, size, sha256, removed: gone.map((b) => b.tag) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- the command line

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'keygen') {
    const out = flag(args, '--out');
    if (!out) throw new Error('keygen --out <private key file>');
    if (fs.existsSync(out)) throw new Error(`${out} exists; refusing to replace a backup key`);
    const k = keygen();
    fs.writeFileSync(out, k.privateText, { mode: 0o600, flag: 'wx' });
    console.log(k.publicText);
    return;
  }
  if (cmd === 'run') {
    await run();
    return;
  }
  if (cmd === 'restore') {
    const keyFile = flag(args, '--key');
    const input = flag(args, '--in');
    const out = flag(args, '--out');
    if (!keyFile || !input || !out) throw new Error('restore --key <file> --in <backup.kwb> --out <snapshot.zip>');
    const h = decryptFile(input, out, fs.readFileSync(keyFile, 'utf8'));
    const tables = zipTables(out);
    console.log(`restored the export of ${h.deployment ?? '?'} made ${h.createdAt ?? '?'}: ${tables.length} tables, in ${out}`);
    console.log(`To load it (this REPLACES the deployment's data): npx convex import --replace-all ${out} (with that deployment's deploy key)`);
    return;
  }
  throw new Error('usage: kiwi-backup.mjs keygen --out <file> | run | restore --key <file> --in <file> --out <file>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e?.message ?? e);
    process.exitCode = 1;
  });
}
