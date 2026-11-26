// Kiwimake Cloud's production deployment (utmost-deer-505), from this PC. Every secret comes from
// ~/.appwin-secrets/cloud-prod.env (made by prod-secrets.mjs and the setup steps, saved to
// 1Password as "Kiwimake Cloud (prod) secrets") and goes to Convex's CLI on stdin only. Nothing is
// ever read from the dev secrets file, so no dev or test key can reach production.
//   node scripts/prod.mjs check      which settings production still lacks (names only)
//   node scripts/prod.mjs env        set every production setting that is in the file
//   node scripts/prod.mjs deploy     push convex/ to production
//   node scripts/prod.mjs bundle     upload the runner bundle that boxes download
//   node scripts/prod.mjs run <fn> '<json>'
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { packRunner } from './dev.mjs';
import { readProd } from './prod-secrets.mjs';

const CLOUD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = readProd();
const DEPLOYMENT = 'utmost-deer-505';
if (!env.CONVEX_DEPLOY_KEY?.startsWith(`prod:${DEPLOYMENT}|`)) throw new Error(`CONVEX_DEPLOY_KEY in cloud-prod.env must be ${DEPLOYMENT}'s production deploy key`);

/** Settings that are not secret and are the same for every production deploy. */
export const PLAIN = {
  SITE_URL: `https://${DEPLOYMENT}.convex.site`,
  CLOUD_AGENT_ENGINE: 'opencode',
  CLOUD_AGENT_PROVIDER: 'openrouter',
  CLOUD_AGENT_FALLBACK: 'therouter',
  BOX_IMAGE_SNAPSHOT: 'anyapp-box-v2',
  SENTRY_ENVIRONMENT: 'production',
};
/** From the file: required, and optional (set when present). */
export const SECRET_NAMES = ['INSTABOX_API_KEY', 'KEYS_KEK', 'KEYS_TRANSPORT_PRIVATE', 'KEYS_TRANSPORT_PUBLIC', 'JWT_PRIVATE_KEY', 'JWKS', 'AUTH_GOOGLE_ID', 'AUTH_GOOGLE_SECRET', 'AUTH_RESEND_KEY', 'AUTH_EMAIL_FROM', 'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET'];
export const OPTIONAL_NAMES = ['GOOGLE_SITE_VERIFICATION', 'SENTRY_DSN', 'SENTRY_RELEASE', 'INSTABOX_WEBHOOK_SECRET', 'GCP_KMS_KEY', 'GCP_KMS_SA', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_ALLOW_LIVE'];
/** Never on production: dev-only switches. */
export const NEVER = ['KIWI_ALLOW_WIPE', 'SPIKE_ANONYMOUS'];
const PEM = path.join(os.homedir(), '.appwin-secrets', 'github-app-prod.pem');

function convex(args, input) {
  const r = spawnSync(process.execPath, [path.join(CLOUD, 'node_modules', 'convex', 'bin', 'main.js'), ...args], {
    cwd: CLOUD,
    // Only the production key: .env.local's CONVEX_DEPLOYMENT (dev) must not pick the deployment.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CONVEX_DEPLOY_KEY: env.CONVEX_DEPLOY_KEY },
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const hide = (s) => String(s ?? '').replace(/\b(prod|dev):[^\s'"]+/g, '[deploy key]');
  if (r.status !== 0) throw new Error(`convex ${args[0]} ${args[1] ?? ''} failed: ${hide(r.stderr || r.stdout).slice(-1500)}`);
  return r.stdout;
}

function setVar(name, value) {
  if (NEVER.includes(name)) throw new Error(`${name} is never set on production`);
  if (name === 'STRIPE_SECRET_KEY' && /^(sk|rk)_test_/.test(value)) throw new Error('a Stripe test key is never set on production');
  convex(['env', 'set', name, '--force'], value);
  console.log(`set ${name}`);
}

function run(fn, args = {}) {
  const out = convex(['run', fn, JSON.stringify(args)]).trim();
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

function missing() {
  const m = SECRET_NAMES.filter((n) => !env[n]);
  if (!fs.existsSync(PEM)) m.push('github-app-prod.pem');
  return m;
}

const cmd = process.argv[1]?.endsWith('prod.mjs') ? process.argv[2] : null;
if (cmd === 'check') {
  const m = missing();
  console.log(m.length ? `missing: ${m.join(' ')}` : 'every required setting is in the file');
  const names = convex(['env', 'list', '--names-only']).split(/\s+/).filter(Boolean);
  console.log(`on production now: ${names.join(' ') || '(none)'}`);
  const bad = names.filter((n) => NEVER.includes(n));
  if (bad.length) console.log(`MUST REMOVE: ${bad.join(' ')}`);
} else if (cmd === 'env') {
  for (const [n, v] of Object.entries(PLAIN)) setVar(n, v);
  for (const n of [...SECRET_NAMES, ...OPTIONAL_NAMES]) if (env[n]) setVar(n, env[n]);
  if (fs.existsSync(PEM)) setVar('GITHUB_APP_PRIVATE_KEY', crypto.createPrivateKey(fs.readFileSync(PEM, 'utf8')).export({ type: 'pkcs8', format: 'pem' }).toString());
  const m = missing();
  if (m.length) console.log(`still missing: ${m.join(' ')}`);
} else if (cmd === 'deploy') {
  const t = Date.now();
  console.log(convex(['deploy', '--typecheck', 'enable', '-y']).split('\n').filter((l) => /Deployed|✔|Schema|index/i.test(l)).join('\n'));
  console.log(`deployed in ${((Date.now() - t) / 1000).toFixed(1)} s`);
} else if (cmd === 'bundle') {
  const file = packRunner();
  const bytes = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  const version = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const url = run('admin:bundleUploadUrl');
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: bytes });
  if (!res.ok) throw new Error(`bundle upload: ${res.status}`);
  const { storageId } = await res.json();
  run('admin:setRunnerBundle', { fileId: storageId, version });
  console.log(`runner bundle ${version} (${(bytes.length / 1e6).toFixed(1)} MB)`);
} else if (cmd === 'run') {
  console.log(JSON.stringify(run(process.argv[3], JSON.parse(process.argv[4] ?? '{}')), null, 2));
} else if (cmd) {
  console.error('usage: node scripts/prod.mjs check | env | deploy | bundle | run <fn> <json>');
  process.exit(2);
}
