// node --test cloud/backup/kiwi-backup.test.mjs: the backup's encryption, its checks, retention,
// the run with a fake export and store, and the GitHub releases store against a local fake API.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { zipSync } from 'fflate';
import { decryptFile, encryptFile, GithubReleases, keygen, planPrune, run, tagFor, zipTables } from './kiwi-backup.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-backup-test-'));
const day = 86_400_000;

function exportZip(file, tables = ['users', 'apps', 'keys', 'messages']) {
  const entries = { 'README.md': new TextEncoder().encode('export') };
  for (const t of tables) entries[`${t}/documents.jsonl`] = new TextEncoder().encode(`{"_id":"${t}1"}\n`);
  entries['_tables/documents.jsonl'] = new TextEncoder().encode('{}\n');
  fs.writeFileSync(file, zipSync(entries));
}

test('encrypt and decrypt: small, empty and several chunks; only the right key opens it', () => {
  const d = tmp();
  const k = keygen();
  const other = keygen();
  for (const size of [0, 10, (1 << 20) * 2 + 7]) {
    const plain = crypto.randomBytes(size);
    fs.writeFileSync(path.join(d, 'p'), plain);
    encryptFile(path.join(d, 'p'), path.join(d, 'c'), k.publicText, { deployment: 'x' });
    const enc = fs.readFileSync(path.join(d, 'c'));
    if (size > 64) assert.equal(enc.includes(plain.subarray(0, 64)), false);
    const h = decryptFile(path.join(d, 'c'), path.join(d, 'o'), k.privateText);
    assert.equal(h.deployment, 'x');
    assert.deepEqual(fs.readFileSync(path.join(d, 'o')), plain);
    assert.throws(() => decryptFile(path.join(d, 'c'), path.join(d, 'o2'), other.privateText), /another backup key/);
  }
});

test('a changed, cut-off or extended backup never decrypts', () => {
  const d = tmp();
  const k = keygen();
  fs.writeFileSync(path.join(d, 'p'), crypto.randomBytes((1 << 20) + 100));
  encryptFile(path.join(d, 'p'), path.join(d, 'c'), k.publicText);
  const good = fs.readFileSync(path.join(d, 'c'));
  const flipped = Buffer.from(good);
  flipped[good.length - 40] ^= 1;
  fs.writeFileSync(path.join(d, 'bad'), flipped);
  assert.throws(() => decryptFile(path.join(d, 'bad'), path.join(d, 'o'), k.privateText));
  // Only the first (non-final) chunk: a cut at a chunk boundary is caught too.
  const firstLen = good.indexOf(0x0a, 6) + 1;
  const len = good.readUInt32BE(firstLen + 1);
  fs.writeFileSync(path.join(d, 'cut'), good.subarray(0, firstLen + 5 + len));
  assert.throws(() => decryptFile(path.join(d, 'cut'), path.join(d, 'o'), k.privateText), /cut off/);
  fs.writeFileSync(path.join(d, 'long'), Buffer.concat([good, Buffer.from('x')]));
  assert.throws(() => decryptFile(path.join(d, 'long'), path.join(d, 'o'), k.privateText), /after its end/);
});

test("the export's tables are read from the ZIP", () => {
  const d = tmp();
  exportZip(path.join(d, 's.zip'));
  assert.deepEqual(zipTables(path.join(d, 's.zip')), ['_tables', 'apps', 'keys', 'messages', 'users']);
  fs.writeFileSync(path.join(d, 'n.zip'), 'not a zip');
  assert.throws(() => zipTables(path.join(d, 'n.zip')), /not a ZIP/);
});

test('retention: older than the days are removed, never the newest few', () => {
  const now = Date.UTC(2026, 11, 31);
  const backups = Array.from({ length: 40 }, (_, i) => ({ id: i, tag: `t${i}`, at: now - i * day }));
  assert.deepEqual(planPrune(backups, now, 30, 7).map((b) => b.id), [31, 32, 33, 34, 35, 36, 37, 38, 39]);
  // A month with no backups (the job was off): the last 7 stay however old they are.
  const old = Array.from({ length: 9 }, (_, i) => ({ id: i, tag: `o${i}`, at: now - (100 + i) * day }));
  assert.deepEqual(planPrune(old, now, 30, 7).map((b) => b.id), [7, 8]);
  assert.equal(tagFor(new Date('2026-11-27T03:17:42Z')), 'backup-202611270317');
});

function fakeStore() {
  const s = { items: [], removed: [], async upload(tag, file, notes) { s.items.push({ id: s.items.length + 1, tag, at: Date.now(), bytes: fs.readFileSync(file), name: path.basename(file), notes }); }, async list() { return s.items; }, async remove(b) { s.removed.push(b.tag); } };
  return s;
}

test('run: export, check, encrypt, upload, prune; refuses dev keys and exports without the key table', async () => {
  const k = keygen();
  const store = fakeStore();
  store.items.push({ id: 99, tag: 'backup-202601010000', at: Date.UTC(2026, 0, 1) });
  for (let i = 1; i <= 7; i++) store.items.push({ id: 100 + i, tag: `backup-recent${i}`, at: Date.UTC(2026, 10, 20 + i) });
  const env = { CONVEX_DEPLOY_KEY: 'prod:happy-otter-123|secretpart', BACKUP_PUBLIC_KEY: k.publicText };
  const r = await run(env, { store, now: () => new Date('2026-11-27T03:17:00Z'), exportTo: (out) => exportZip(out), log: () => {} });
  assert.deepEqual(r.tables, ['_tables', 'apps', 'keys', 'messages', 'users']);
  assert.deepEqual(r.removed, ['backup-202601010000']);
  const up = store.items.find((i) => i.tag === 'backup-202611270317');
  assert.equal(up.name, 'kiwimake-happy-otter-123-202611270317.kwb');
  assert.equal(up.notes.includes('secretpart'), false);
  const d = tmp();
  fs.writeFileSync(path.join(d, 'b'), up.bytes);
  decryptFile(path.join(d, 'b'), path.join(d, 'z.zip'), k.privateText);
  assert.ok(zipTables(path.join(d, 'z.zip')).includes('keys'));

  await assert.rejects(run({ ...env, CONVEX_DEPLOY_KEY: 'dev:x|y' }, { store, exportTo: exportZip }), /dev deploy key/);
  await assert.rejects(run(env, { store, exportTo: (out) => exportZip(out, ['users', 'apps']), log: () => {} }), /no keys table/);
  // Never deployed to: a notice, nothing uploaded, nothing pruned.
  const before = store.items.length;
  const notes = [];
  const empty = await run(env, { store, exportTo: (out) => exportZip(out, []), log: (m) => notes.push(m) });
  assert.equal(empty.empty, true);
  assert.equal(store.items.length, before);
  assert.match(notes[0], /^::warning::happy-otter-123 has no tables yet/);
  await assert.rejects(run({ ...env, BACKUP_PUBLIC_KEY: 'nope' }, { store, exportTo: exportZip }), /BACKUP_PUBLIC_KEY/);
});

test('GitHub releases: refuses a public repo; uploads, lists and removes in a private one', async () => {
  const seen = [];
  let isPrivate = false;
  const releases = [{ id: 1, tag_name: 'backup-202601010000', created_at: '2026-01-01T00:00:00Z' }, { id: 2, tag_name: 'v1.0', created_at: '2026-01-02T00:00:00Z' }];
  const server = http.createServer((req, res) => {
    let body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, size: Buffer.concat(body).length });
      const send = (status, j) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(j === undefined ? '' : JSON.stringify(j)); };
      if (req.method === 'GET' && req.url === '/repos/me/backups') return send(200, { private: isPrivate });
      if (req.method === 'GET' && req.url.startsWith('/repos/me/backups/releases')) return send(200, releases);
      if (req.method === 'POST' && req.url === '/repos/me/backups/releases') return send(201, { id: 7 });
      if (req.method === 'POST' && req.url.startsWith('/repos/me/backups/releases/7/assets')) return send(201, { id: 70 });
      if (req.method === 'DELETE') return send(204);
      send(500, { url: req.url });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const gh = new GithubReleases({ repo: 'me/backups', token: 'ghs_test', api: base, uploads: base });
    await assert.rejects(gh.checkPrivate(), /is public/);
    isPrivate = true;
    await gh.checkPrivate();
    const d = tmp();
    fs.writeFileSync(path.join(d, 'a.kwb'), Buffer.alloc(1234, 1));
    assert.equal(await gh.upload('backup-202611270317', path.join(d, 'a.kwb'), 'notes'), 7);
    assert.deepEqual(await gh.list(), [{ id: 1, tag: 'backup-202601010000', at: Date.parse('2026-01-01T00:00:00Z') }]);
    await gh.remove({ id: 1, tag: 'backup-202601010000' });
    assert.ok(seen.some((s) => s.url === '/repos/me/backups/releases/7/assets?name=a.kwb' && s.size === 1234));
    assert.ok(seen.some((s) => s.method === 'DELETE' && s.url === '/repos/me/backups/git/refs/tags/backup-202601010000'));
    assert.ok(seen.every((s) => s.auth === 'Bearer ghs_test'));
  } finally {
    server.close();
  }
  assert.throws(() => new GithubReleases({ repo: 'not a repo', token: 'x' }), /owner\/name/);
});
