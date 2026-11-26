// Deleting an app and an account for real, the undo window, the signing keys' grace period, old
// build files, Stripe's portal, and the two downloads (docs/CLOUD.md section 6, "Deleting an app,
// an account, and downloading your data"), with a fake Stripe and a fake GitHub.
import crypto from 'node:crypto';
import { convexTest } from 'convex-test';
import { unzipSync, strFromU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { PRIVACY } from '../convex/config';
import { envelopeSeal, hmacSha256B64 } from '../convex/lib/crypto';

const modules = import.meta.glob('../convex/**/*.*s');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

let stripeCalls: { method: string; url: string; body: string }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-26T10:00:00Z'));
  vi.stubEnv('KEYS_KEK', btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_fake');
  vi.stubEnv('CONVEX_SITE_URL', 'https://example.convex.site');
  stripeCalls = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.stripe.com/')) {
      stripeCalls.push({ method: init?.method ?? 'GET', url, body: String(init?.body ?? '') });
      if (url.endsWith('/billing_portal/configurations')) return Response.json({ id: 'bpc_test_1' });
      if (url.endsWith('/billing_portal/sessions')) return Response.json({ url: 'https://billing.stripe.com/p/session/test_1' });
      if (url.includes('/customers/') && init?.method === 'DELETE') return Response.json({ id: 'cus_1', deleted: true });
      return Response.json({ error: { message: 'unexpected' } }, { status: 400 });
    }
    throw new Error(`no network in tests: ${url}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert('users', { email: 'a@example.com', githubLogin: 'a', githubInstallationId: '1' }));
  const as = t.withIdentity({ subject: `${userId}|s` });
  const now = Date.now();
  // An app with a chat (and a picture), a page, a to-do, five builds with files, a key and a change.
  const ids = await t.run(async (ctx) => {
    const file = (s: string) => ctx.storage.store(new Blob([s]));
    const iconFileId = await file('icon');
    const appId = await ctx.db.insert('apps', {
      userId,
      name: 'Tea Timer',
      slug: 'teatimer',
      packageName: 'com.anyappcloud.teatimer',
      place: 'cloud',
      buildHigh: 5,
      iconFileId,
      iconVersion: 1,
      status: 'idle',
      prompt: 'a tea timer',
      overview: 'Times tea.',
      updatedAt: now,
    });
    const threadId = await ctx.db.insert('threads', { appId, userId, boxState: 'none', lastActiveAt: now, seq: 3 });
    const picture = await file('jpeg bytes');
    await ctx.db.insert('messages', {
      threadId,
      itemId: 'u1',
      seq: 1,
      item: { id: 'u1', kind: 'user', text: 'Make it green', images: [{ fileId: picture, mimeType: 'image/jpeg' }], createdAt: new Date(now).toISOString() },
      updatedAt: now,
    });
    await ctx.db.insert('messages', { threadId, itemId: 'a1', seq: 2, item: { id: 'a1', kind: 'assistant', text: 'Done, it is green.', createdAt: new Date(now).toISOString() }, updatedAt: now });
    const html = await ctx.storage.store(new Blob(['<h1>Plan</h1>'], { type: 'text/html' }));
    await ctx.db.insert('pages', { threadId, pageId: 'plan-1', info: { title: 'Plan' }, htmlFileId: html });
    await ctx.db.insert('todos', { appId, text: 'Add a sound', done: false, at: now });
    const builds = [];
    for (let n = 1; n <= 5; n++) {
      const fileId = await file(`apk ${n}`);
      builds.push(fileId);
      await ctx.db.insert('builds', { appId, number: n, delivery: 'apk', files: [{ abi: 'arm64-v8a', fileId, sizeBytes: 5, sha256: 'x' }], info: { number: n }, pushed: true });
    }
    const sealed = await envelopeSeal(new TextEncoder().encode(JSON.stringify({ p12: btoa('PKCS12 bytes'), storePassword: 'store-pass', keyAlias: 'app' })), `appkey:${appId}:com.anyappcloud.teatimer`);
    await ctx.db.insert('keys', { appId, userId, packageName: 'com.anyappcloud.teatimer', certSha256: 'c'.repeat(64), ...sealed, at: now });
    await ctx.db.insert('changes', {
      appId,
      threadId,
      userId,
      messageItemId: 'u1',
      actual: { machineMicros: 1, aiMicros: 1, millicredits: 900 },
      aiPaidBy: 'credit',
      state: 'done',
      startedAt: now,
    });
    return { appId, threadId, picture, html, builds, iconFileId };
  });
  const fileGone = (id: Id<'_storage'>) => t.run(async (ctx) => (await ctx.storage.get(id)) === null);
  return { t, as, userId, ...ids, fileGone };
}

describe('deleting one cloud app', () => {
  test('it leaves the grid at once, comes back within the undo window, and is deleted for real after it', async () => {
    const { t, as, appId, threadId, picture, html, builds, iconFileId, fileGone } = await setup();
    expect(await as.query(api.apps.list, {})).toHaveLength(1);
    const { purgeAt } = (await as.mutation(api.apps.remove, { appId })) as { purgeAt: number };
    expect(Math.abs(purgeAt - Date.now() - PRIVACY.appUndoMinutes * MIN)).toBeLessThan(1000);
    expect(await as.query(api.apps.list, {})).toHaveLength(0);
    const recent = await as.query(api.apps.recentlyDeleted, {});
    expect(recent.map((a: { name: string }) => a.name)).toEqual(['Tea Timer']);
    // The app's open sheet keeps asking about it: those answers are null, not errors (an error
    // blanks the phone's screen).
    expect(await as.query(api.estimates.forApp, { appId })).toBeNull();
    expect(await as.query(api.signing.log, { appId })).toBeNull();

    // Undo: back in the grid with its chat.
    await as.mutation(api.apps.restore, { appId });
    expect(await as.query(api.apps.list, {})).toHaveLength(1);
    expect(await as.query(api.chat.messages, { appId })).toHaveLength(2);
    // The first deletion's scheduled purge finds it restored and does nothing.
    await t.mutation(internal.privacy.purgeApp, { appId });
    expect(await t.run((ctx) => ctx.db.get(appId))).not.toBeNull();

    // Deleted again, and the window passes.
    await as.mutation(api.apps.remove, { appId });
    vi.advanceTimersByTime(PRIVACY.appUndoMinutes * MIN + 1000);
    await expect(as.mutation(api.apps.restore, { appId })).rejects.toThrow(/deleted for good/);
    await t.mutation(internal.privacy.purgeApp, { appId });
    const left = await t.run(async (ctx) => ({
      app: await ctx.db.get(appId),
      thread: await ctx.db.get(threadId),
      messages: await ctx.db.query('messages').collect(),
      pages: await ctx.db.query('pages').collect(),
      todos: await ctx.db.query('todos').collect(),
      builds: await ctx.db.query('builds').collect(),
      keys: await ctx.db.query('keys').collect(),
      changes: await ctx.db.query('changes').collect(),
    }));
    expect(left.app).toBeNull();
    expect(left.thread).toBeNull();
    expect(left.messages).toHaveLength(0);
    expect(left.pages).toHaveLength(0);
    expect(left.todos).toHaveLength(0);
    expect(left.builds).toHaveLength(0);
    for (const f of [picture, html, iconFileId, ...builds]) expect(await fileGone(f)).toBe(true);
    // The key waits out its grace period; what the change cost stays with the account.
    expect(left.keys).toHaveLength(1);
    expect(Math.abs(left.keys[0].deleteAfter! - Date.now() - PRIVACY.keyGraceDays * DAY)).toBeLessThan(5000);
    expect(left.changes).toHaveLength(1);

    // Until then the person can still save it, under the app's name, and the account says so.
    const userId = left.keys[0].userId;
    const kept = await t.query(internal.privacy.keysFor, { userId });
    expect(kept?.map((k) => [k.name, k.aad])).toEqual([['Tea Timer', `appkey:${appId}:${left.keys[0].packageName}`]]);
    expect((await as.query(api.privacy.summary, {}))?.keptKeys.map((k) => k.name)).toEqual(['Tea Timer']);

    // The hourly sweep deletes the key once the grace period is over, not before.
    await t.mutation(internal.privacy.sweep, {});
    expect(await t.run((ctx) => ctx.db.query('keys').collect())).toHaveLength(1);
    vi.advanceTimersByTime(PRIVACY.keyGraceDays * DAY + MIN);
    expect(await t.query(internal.privacy.keysFor, { userId })).toEqual([]);
    await t.mutation(internal.privacy.sweep, {});
    expect(await t.run((ctx) => ctx.db.query('keys').collect())).toHaveLength(0);
  });

  test('an app whose machine is still there waits for it to go', async () => {
    const { t, as, appId, threadId } = await setup();
    await t.run((ctx) => ctx.db.patch(threadId, { boxState: 'paused', snapshotId: 'snap_1' }));
    await as.mutation(api.apps.remove, { appId });
    vi.advanceTimersByTime(PRIVACY.appUndoMinutes * MIN + 1000);
    await t.mutation(internal.privacy.purgeApp, { appId });
    expect(await t.run((ctx) => ctx.db.get(appId))).not.toBeNull();
    // The machine went (boxes.retire), then the purge finishes.
    await t.run((ctx) => ctx.db.patch(threadId, { boxState: 'deleted', snapshotId: undefined }));
    await t.mutation(internal.privacy.purgeApp, { appId });
    expect(await t.run((ctx) => ctx.db.get(appId))).toBeNull();
  });
});

describe('old build files', () => {
  test('only the newest few builds keep their files; the rows stay', async () => {
    const { t, builds, fileGone } = await setup();
    await t.mutation(internal.privacy.sweepBuilds, {});
    const rows = await t.run((ctx) => ctx.db.query('builds').collect());
    expect(rows.filter((b) => b.files.length).map((b) => b.number)).toEqual([3, 4, 5].slice(-PRIVACY.keepBuilds));
    expect(rows).toHaveLength(5);
    expect(await fileGone(builds[0])).toBe(true);
    expect(await fileGone(builds[4])).toBe(false);
  });
});

describe('deleting the account', () => {
  test('a stray call cannot do it; confirmed, the plan ends at Stripe and every row about the person goes', async () => {
    const { t, as, userId, appId, picture, fileGone } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(userId, { stripeCustomerId: 'cus_1' });
      await ctx.db.insert('subscriptions', { userId, plan: 'starter', interval: 'month', stripeSubscriptionId: 'sub_1', status: 'active', periodStart: 0, periodEnd: 1, cancelAtPeriodEnd: false, boxSecondsThisMonth: 0, firstAppDone: true });
      await ctx.db.insert('balances', { userId, millicredits: 5000 });
      await ctx.db.insert('grants', { userId, source: 'plan', millicredits: 30000, remaining: 5000, grantedAt: 0, expiresAt: Date.now() + DAY });
      await ctx.db.insert('ledger', { userId, kind: 'grant', millicredits: 30000, at: 0 });
      await ctx.db.insert('secrets', { userId, kind: 'anthropic', ciphertext: 'x', iv: 'y', last4: 'abcd' });
      await ctx.db.insert('pcLinks', { userId, tokenHash: 'h', deviceName: 'PC', scopes: ['move'], linkedFrom: 'pc', createdAt: 0 });
      const sessionId = await ctx.db.insert('authSessions', { userId, expirationTime: Date.now() + DAY });
      await ctx.db.insert('authRefreshTokens', { sessionId, expirationTime: Date.now() + DAY });
      await ctx.db.insert('authAccounts', { userId, provider: 'resend-otp', providerAccountId: 'a@example.com' });
    });
    const summary = await as.query(api.privacy.summary, {});
    expect(summary.apps).toEqual([expect.objectContaining({ name: 'Tea Timer', hasKey: true })]);
    expect(summary.plan).toEqual({ name: 'Starter', cancelAtPeriodEnd: false });

    await expect(as.mutation(api.privacy.deleteAccount, { confirm: 'yes' })).rejects.toThrow(/Confirm/);
    await as.mutation(api.privacy.deleteAccount, { confirm: 'delete my account' });
    // Refused everywhere at once.
    await expect(as.query(api.apps.get, { appId })).rejects.toThrow(/being deleted/);
    expect(await as.query(api.accounts.me, {})).toBeNull();

    await t.action(internal.privacy.deleteAccountRun, { userId });
    expect(stripeCalls.some((c) => c.method === 'DELETE' && c.url.endsWith('/customers/cus_1'))).toBe(true);
    const left = await t.run(async (ctx) => {
      const count = async (table: string) => (await ctx.db.query(table as never).collect()).length;
      const out: Record<string, number> = {};
      for (const table of ['users', 'apps', 'threads', 'messages', 'pages', 'todos', 'builds', 'changes', 'subscriptions', 'balances', 'grants', 'ledger', 'secrets', 'pcLinks', 'authSessions', 'authRefreshTokens', 'authAccounts']) out[table] = await count(table);
      return { out, keys: await ctx.db.query('keys').collect() };
    });
    expect(Object.values(left.out).every((n) => n === 0)).toBe(true);
    expect(await fileGone(picture)).toBe(true);
    // Only the sealed signing key is left, for its grace period.
    expect(left.keys).toHaveLength(1);
    expect(Math.abs(left.keys[0].deleteAfter! - Date.now() - PRIVACY.keyGraceDays * DAY)).toBeLessThan(5000);
  });
});

describe("Stripe's portal", () => {
  test('Manage plan opens the portal; our settings are made once; a cancellation shows as ending', async () => {
    const { t, as, userId } = await setup();
    await expect(as.action(api.stripe.portal, {})).rejects.toThrow(/no plan or payments/);
    await t.run(async (ctx) => {
      await ctx.db.patch(userId, { stripeCustomerId: 'cus_1' });
      await ctx.db.insert('subscriptions', { userId, plan: 'starter', interval: 'month', stripeSubscriptionId: 'sub_1', status: 'active', periodStart: 0, periodEnd: 1, cancelAtPeriodEnd: false, boxSecondsThisMonth: 0, firstAppDone: true });
    });
    expect(await as.action(api.stripe.portal, {})).toEqual({ url: 'https://billing.stripe.com/p/session/test_1' });
    expect(await as.action(api.stripe.portal, {})).toEqual({ url: 'https://billing.stripe.com/p/session/test_1' });
    const made = stripeCalls.filter((c) => c.url.endsWith('/billing_portal/configurations'));
    expect(made).toHaveLength(1);
    expect(decodeURIComponent(made[0].body)).toContain('features[subscription_cancel][enabled]=true');
    const sessions = stripeCalls.filter((c) => c.url.endsWith('/billing_portal/sessions'));
    expect(decodeURIComponent(sessions[1].body)).toContain('configuration=bpc_test_1');
    expect(decodeURIComponent(sessions[1].body)).toContain('return_url=https://example.convex.site/billing/done?portal=1');

    // The portal's cancellation reaches us as a subscription update with cancel_at.
    const ends = Date.UTC(2026, 11, 26) / 1000;
    const body = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', cancel_at_period_end: false, cancel_at: ends } } });
    const ts = Math.floor(Date.now() / 1000);
    const b64 = await hmacSha256B64(new TextEncoder().encode('whsec_fake'), `${ts}.${body}`);
    const hex = [...Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect((await t.fetch('/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': `t=${ts},v1=${hex}` }, body })).status).toBe(200);
    const me = (await as.query(api.accounts.me, {}))!;
    expect(me.billing).toBe(true);
    expect(me.plan).toMatchObject({ id: 'starter', cancelAtPeriodEnd: true, renewsAt: ends * 1000 });
  });
});

describe('downloads', () => {
  test('Download my data: one zip with the account and each app, by a link that ends', async () => {
    const { t, as } = await setup();
    const link = await as.action(api.privacyNode.myData, {});
    expect(link.url).toMatch(/^https:\/\/example\.convex\.site\/download\/[A-Za-z0-9_-]{20,}$/);
    expect(link.fileName).toBe('kiwimake-data-2026-11-26.zip');
    await expect(as.action(api.privacyNode.myData, {})).rejects.toThrow(/a moment ago/);
    const res = await t.fetch(new URL(link.url).pathname);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('kiwimake-data-2026-11-26.zip');
    const all = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const files = Object.fromEntries(Object.entries(all).filter(([name]) => !name.endsWith('/')));
    expect(Object.keys(files).sort()).toEqual(
      ['README.txt', 'account.json', 'apps/Tea-Timer/app.json', 'apps/Tea-Timer/chat.json', 'apps/Tea-Timer/chat.txt', 'apps/Tea-Timer/code.txt', 'apps/Tea-Timer/icon.png', 'apps/Tea-Timer/pages/plan-1.html', 'apps/Tea-Timer/todos.json', 'apps/Tea-Timer/versions.json'].concat(
        Object.keys(files).filter((f) => f.startsWith('apps/Tea-Timer/pictures/')),
      ).sort(),
    );
    expect(Object.keys(files).some((f) => f.startsWith('apps/Tea-Timer/pictures/'))).toBe(true);
    const account = JSON.parse(strFromU8(files['account.json']));
    expect(account.account.email).toBe('a@example.com');
    expect(account.apps[0]).toMatchObject({ name: 'Tea Timer', firstMessage: 'a tea timer' });
    expect(strFromU8(files['apps/Tea-Timer/chat.txt'])).toContain('You (2026-11-26 10:00 UTC):\nMake it green');
    expect(strFromU8(files['apps/Tea-Timer/code.txt'])).toContain('no code on GitHub yet');
    // Nothing secret: no key material in the data file.
    expect(strFromU8(files['apps/Tea-Timer/app.json'])).not.toContain('store-pass');

    vi.advanceTimersByTime(PRIVACY.downloadMinutes * MIN + 1000);
    expect((await t.fetch(new URL(link.url).pathname)).status).toBe(410);
    await t.mutation(internal.privacy.sweep, {});
    expect(await t.run((ctx) => ctx.db.query('downloads').collect())).toHaveLength(0);
  });

  test('Save signing keys: the desktop key backup format, locked with the person password', async () => {
    const { t, as } = await setup();
    await expect(as.action(api.privacyNode.signingKeys, { password: 'short' })).rejects.toThrow(/at least 8/);
    const link = await as.action(api.privacyNode.signingKeys, { password: 'tea-is-green' });
    expect(link.count).toBe(1);
    expect(link.fileName).toBe('kiwimake-signing-keys-tea-timer-2026-11-26.anyappkeys');
    const doc = JSON.parse(await (await t.fetch(new URL(link.url).pathname)).text());
    expect(doc).toMatchObject({ format: 'anyappagent-signing-keys', version: 1, count: 1, kdf: { name: 'scrypt' }, cipher: { name: 'aes-256-gcm' } });
    // Opened exactly as builder/lib/keybackup.mjs readBackup does.
    const header = { format: doc.format, version: doc.version, createdAt: doc.createdAt, count: doc.count };
    const key = crypto.scryptSync('tea-is-green', Buffer.from(doc.kdf.salt, 'base64'), 32, { N: doc.kdf.N, r: doc.kdf.r, p: doc.kdf.p, maxmem: 256 * 1024 * 1024 });
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(doc.cipher.iv, 'base64'));
    d.setAAD(Buffer.from(JSON.stringify(header), 'utf8'));
    d.setAuthTag(Buffer.from(doc.cipher.tag, 'base64'));
    const { keys } = JSON.parse(Buffer.concat([d.update(Buffer.from(doc.data, 'base64')), d.final()]).toString('utf8'));
    expect(keys).toEqual([
      {
        id: 'com.anyappcloud.teatimer',
        info: expect.objectContaining({ kind: 'own', packageName: 'com.anyappcloud.teatimer', storePassword: 'store-pass', keyAlias: 'app', keyPassword: 'store-pass', certSha256: 'c'.repeat(64) }),
        files: { store: btoa('PKCS12 bytes') },
      },
    ]);
  });
});

describe('sign-ups that never finished', () => {
  test('a day after asking for a code and never using it, the address goes; finished, busy and fresh ones stay', async () => {
    const { t, userId } = await setup();
    // An address that asked for a code and never used it (Convex Auth made its rows at once).
    const stub = async (email: string, codeFor: number) =>
      t.run(async (ctx) => {
        const id = await ctx.db.insert('users', { email });
        const accountId = await ctx.db.insert('authAccounts', { userId: id, provider: 'resend-otp', providerAccountId: email });
        await ctx.db.insert('authVerificationCodes', { accountId, provider: 'resend-otp', code: `hash-${email}`, expirationTime: Date.now() + codeFor, emailVerified: email });
        return { id, accountId };
      });
    const gone = await stub('never@example.com', 10 * MIN);
    const back = await stub('back@example.com', 10 * MIN);
    const finished = await t.run((ctx) => ctx.db.insert('users', { email: 'done@example.com', emailVerificationTime: Date.now() }));
    vi.setSystemTime(Date.now() + DAY + 60 * MIN);
    // Someone back to finish right now: a fresh code is running for them.
    await t.run((ctx) => ctx.db.insert('authVerificationCodes', { accountId: back.accountId, provider: 'resend-otp', code: 'hash-again', expirationTime: Date.now() + 10 * MIN, emailVerified: 'back@example.com' }));
    const fresh = await stub('fresh@example.com', 10 * MIN);

    expect(await t.mutation(internal.privacy.sweepUnverified, {})).toEqual({ removed: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await t.run(async (ctx) => ({
      users: (await ctx.db.query('users').collect()).map((u) => u._id),
      accounts: (await ctx.db.query('authAccounts').collect()).map((a) => a._id),
      codes: (await ctx.db.query('authVerificationCodes').collect()).map((c) => c.accountId),
    }));
    expect(left.users).not.toContain(gone.id);
    expect(left.accounts).not.toContain(gone.accountId);
    expect(left.codes).not.toContain(gone.accountId);
    // The account with GitHub (no verified email in this test), the finished one, the one coming back, and the fresh one.
    expect(left.users).toEqual(expect.arrayContaining([userId, finished, back.id, fresh.id]));
    // Nothing more the next run.
    expect(await t.mutation(internal.privacy.sweepUnverified, {})).toEqual({ removed: 0 });
  });
});
