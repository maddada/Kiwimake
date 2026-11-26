// Sets Kiwimake up inside a Stripe account it shares with another app (Sharptabs), in test or live
// mode, for one Convex deployment (docs/CLOUD.md section 5). Everything it makes carries metadata
// app=kiwimake and nothing else in the account is read for changes, renamed or removed:
//   - one Product per paid plan and one for extra credit, with Prices exactly as convex/config.ts
//     has them, found again later by lookup key (kiwimake_<plan>_<month|year>, kiwimake_extra_20);
//   - Kiwimake's own webhook endpoint on <deployment>/stripe/webhook with only the events it reads;
//   - STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET (and STRIPE_ALLOW_LIVE=1 for live) on Convex.
// The customer portal configuration is Kiwimake's own too; the deployment makes it on first use.
//
// Keys never appear on a command line or in output: each comes from an owner-only file (for
// example the one `ghostex secret request` saves) and goes to Convex's CLI on stdin.
//   node scripts/stripe-setup.mjs --deployment dev  --setup-key-file <f> --runtime-key-file <f>
//   node scripts/stripe-setup.mjs --deployment prod --setup-key-file <f> --runtime-key-file <f> --deploy-key-file <f>
// --setup-key-file: a key allowed to write Products, Prices and Webhook endpoints (a temporary
//   restricted key, deleted afterwards). --runtime-key-file: the restricted key the deployment
//   keeps (Customers, Checkout Sessions and Customer portal write; Prices and Subscriptions read).
// --dry-run reads and reports only. Test keys go only to dev, live keys only to prod.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLOUD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? '1' : all[i + 1]]] : acc), []));
const deployment = args.deployment;
if (deployment !== 'dev' && deployment !== 'prod') throw new Error('--deployment dev|prod');
const dryRun = args['dry-run'] === '1';
const read = (f, what) => {
  if (!f) throw new Error(`--${what} is needed`);
  return fs.readFileSync(f.replace(/^~/, os.homedir()), 'utf8').trim();
};
const setupKey = read(args['setup-key-file'], 'setup-key-file');
const runtimeKey = dryRun ? '' : read(args['runtime-key-file'], 'runtime-key-file');
const live = /^(sk|rk)_live_/.test(setupKey);
if (!live && !/^(sk|rk)_test_/.test(setupKey)) throw new Error('the setup key is not a Stripe secret or restricted key');
if (live !== (deployment === 'prod')) throw new Error('test keys go only to dev, live keys only to prod');
if (runtimeKey && /^(sk|rk)_live_/.test(runtimeKey) !== live) throw new Error('the two keys are not of the same mode');

// The plans, from config.ts (read as text: this script runs on plain Node).
const config = fs.readFileSync(path.join(CLOUD, 'convex', 'config.ts'), 'utf8');
const plans = [...config.matchAll(/(\w+): \{ id: '(\w+)', name: '([^']+)', cents: \{ month: (\d+), year: (\d+) \}/g)]
  .map((m) => ({ id: m[2], name: m[3], month: Number(m[4]), year: Number(m[5]) }))
  .filter((p) => p.month > 0);
const extra = /EXTRA_PACK = \{ cents: (\d+), millicredits: (\d+)/.exec(config);
if (plans.length !== 4 || !extra) throw new Error(`config.ts not understood (${plans.length} paid plans)`);
const EXTRA_CENTS = Number(extra[1]);
const EXTRA_CREDITS = Number(extra[2]) / 1000;
const EVENTS = ['checkout.session.completed', 'invoice.paid', 'invoice.payment_failed', 'customer.subscription.updated', 'customer.subscription.deleted'];
const TAG = { app: 'kiwimake' };

function enc(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? enc(x, `${key}[${i}]`, out) : out.push([`${key}[${i}]`, String(x)])));
    else if (typeof v === 'object') enc(v, key, out);
    else out.push([key, String(v)]);
  }
  return out;
}
async function stripe(method, p, body) {
  if (dryRun && method !== 'GET') {
    console.log(`  (dry run) ${method} ${p}`);
    return { id: '(dry run)' };
  }
  const res = await fetch(`https://api.stripe.com/v1${p}`, {
    method,
    headers: { Authorization: `Bearer ${setupKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    ...(body ? { body: new URLSearchParams(enc(body)).toString() } : {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${p.split('?')[0]}: ${res.status} ${json?.error?.message ?? ''}`);
  return json;
}
async function listAll(p) {
  const out = [];
  let after = '';
  for (;;) {
    const r = await stripe('GET', `${p}${p.includes('?') ? '&' : '?'}limit=100${after ? `&starting_after=${after}` : ''}`);
    out.push(...r.data);
    if (!r.has_more) return out;
    after = r.data.at(-1).id;
  }
}

// The Convex deployment.
const deployKey = deployment === 'dev' ? readEnvFile().CONVEX_DEPLOY_KEY : read(args['deploy-key-file'], 'deploy-key-file');
if (!deployKey?.startsWith(`${deployment}:`)) throw new Error(`the Convex deploy key is not a ${deployment} key`);
function convex(cliArgs, input) {
  const r = spawnSync(process.execPath, [path.join(CLOUD, 'node_modules', 'convex', 'bin', 'main.js'), ...cliArgs], { cwd: CLOUD, env: { ...process.env, CONVEX_DEPLOY_KEY: deployKey }, input, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`convex ${cliArgs.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout).slice(-800)}`);
  return r.stdout;
}
function readEnvFile() {
  const f = path.join(os.homedir(), '.appwin-secrets', 'cloud-dev.env');
  return Object.fromEntries(fs.readFileSync(f, 'utf8').split(/\r?\n/).map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
}
const siteName = deployKey.slice(deployment.length + 1).split('|')[0];
const WEBHOOK_URL = `https://${siteName}.convex.site/stripe/webhook`;

const account = await stripe('GET', '/balance');
console.log(`Stripe ${live ? 'LIVE' : 'test'} mode (balance livemode ${account.livemode}); Convex ${deployment} ${siteName}`);

// 1. Products and Prices.
const products = (await listAll('/products?active=true')).filter((p) => p.metadata?.app === 'kiwimake');
const wanted = [
  ...plans.flatMap((p) => ['month', 'year'].map((interval) => ({ product: { key: p.id, name: `Kiwimake ${p.name}`, description: `Kiwimake Cloud, the ${p.name} plan` }, lookup: `kiwimake_${p.id.toLowerCase()}_${interval}`, cents: p[interval], interval, nickname: `${p.name}, ${interval === 'month' ? 'monthly' : 'yearly'}` }))),
  { product: { key: 'extra', name: 'Kiwimake extra credit', description: `${EXTRA_CREDITS} credits for Kiwimake Cloud, valid 12 months` }, lookup: 'kiwimake_extra_20', cents: EXTRA_CENTS, nickname: `Extra credit, ${EXTRA_CREDITS} credits` },
];
const made = [];
for (const w of wanted) {
  let product = products.find((p) => p.metadata?.plan === w.product.key);
  if (!product) {
    product = await stripe('POST', '/products', { name: w.product.name, description: w.product.description, metadata: { ...TAG, plan: w.product.key } });
    products.push({ ...product, metadata: { ...TAG, plan: w.product.key } });
    console.log(`made product ${product.id} ${w.product.name}`);
  }
  const have = (await stripe('GET', `/prices?active=true&lookup_keys[]=${w.lookup}`)).data[0];
  if (have && have.unit_amount === w.cents && have.currency === 'usd' && (have.recurring?.interval ?? null) === (w.interval ?? null) && have.product === product.id) {
    made.push({ lookup: w.lookup, price: have.id, product: product.id, cents: w.cents, kept: true });
    continue;
  }
  const price = await stripe('POST', '/prices', {
    product: product.id,
    currency: 'usd',
    unit_amount: w.cents,
    nickname: w.nickname,
    lookup_key: w.lookup,
    transfer_lookup_key: have ? 'true' : undefined,
    ...(w.interval ? { recurring: { interval: w.interval } } : {}),
    metadata: { ...TAG, plan: w.product.key, ...(w.interval ? { interval: w.interval } : {}) },
  });
  if (have && !dryRun) await stripe('POST', `/prices/${have.id}`, { active: 'false' });
  made.push({ lookup: w.lookup, price: price.id, product: product.id, cents: w.cents, kept: false });
}
console.table(made);

// 2. The webhook endpoint (Kiwimake's own; other endpoints in the account are not touched).
const endpoints = (await listAll('/webhook_endpoints')).filter((e) => e.url === WEBHOOK_URL);
let webhookSecret = '';
if (endpoints.length) {
  console.log(`webhook endpoint already there: ${endpoints.map((e) => `${e.id} (${e.status})`).join(', ')}; its secret is not shown again, so it is kept only if Convex has it`);
  const names = dryRun ? '' : convex(['env', 'list']).split('\n').map((l) => l.split('=')[0]);
  if (!dryRun && !names.includes('STRIPE_WEBHOOK_SECRET')) throw new Error('an endpoint exists but Convex has no STRIPE_WEBHOOK_SECRET: delete that endpoint in the dashboard and run again');
} else {
  const e = await stripe('POST', '/webhook_endpoints', { url: WEBHOOK_URL, description: `Kiwimake Cloud (${deployment}): credits and plans`, enabled_events: EVENTS, metadata: TAG });
  webhookSecret = e.secret ?? '';
  if (!dryRun) {
    if (e.livemode !== live) throw new Error('endpoint made in the wrong mode: stop');
    if (!/^whsec_/.test(webhookSecret)) throw new Error('no signing secret in the answer');
  }
  console.log(`made webhook endpoint ${e.id} for ${WEBHOOK_URL} (${EVENTS.length} events)`);
}

// 3. The deployment's env (stdin only).
if (!dryRun) {
  const set = (name, value) => {
    convex(['env', 'set', name, '--force'], value);
    console.log(`set ${name} on ${deployment}`);
  };
  set('STRIPE_SECRET_KEY', runtimeKey);
  if (webhookSecret) set('STRIPE_WEBHOOK_SECRET', webhookSecret);
  if (live) set('STRIPE_ALLOW_LIVE', '1');
}
console.log('done');
