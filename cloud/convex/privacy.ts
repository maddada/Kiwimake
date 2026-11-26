// Deleting a cloud app, deleting the account, and the files a person can download (docs/CLOUD.md
// section 6, "Deleting an app, an account, and downloading your data"). The rules, each one
// constant in config.ts (PRIVACY):
// - A deleted app can be brought back for PRIVACY.appUndoMinutes. Its machine goes at once; then
//   its chat, pages, pictures, to-dos, builds and their files are deleted for good. Its signing key
//   stays sealed PRIVACY.keyGraceDays more, then is deleted. Its code stays on the person's GitHub.
//   What it cost (changes, usage, the credit ledger) stays with the account until it is deleted.
// - Deleting the account deletes the Stripe customer (which ends the plan at once, nothing more is
//   charged), every machine and snapshot, every app as above, and every row about the person:
//   credits, usage, linked PCs, stored secrets, sign-in sessions, the account itself. Signing keys
//   follow the same grace period.
// - Downloads (the person's data, their signing keys) are files in storage behind a one-time link
//   (only its hash is kept) that works for PRIVACY.downloadMinutes; then the file is deleted.
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id, TableNames } from './_generated/dataModel';
import { httpAction, internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx } from './_generated/server';
import { PLANS, PRIVACY } from './config';
import { envelopeSeal, randomToken, sha256Hex } from './lib/crypto';
import { requireUser, Refused } from './lib/session';
import { stripe } from './stripe';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Documents one purge step may delete or change (well under a mutation's write limit). */
const STEP = 400;

type Budget = { left: number };
type StepResult = 'done' | 'more' | 'wait';

// ---------- files inside rows

/** Storage ids of the pictures a chat item or an inbox payload carries ({ images: [{ fileId }] }). */
function pictureIds(ctx: MutationCtx, value: unknown): Id<'_storage'>[] {
  const images = (value as { images?: unknown } | null)?.images;
  if (!Array.isArray(images)) return [];
  const out: Id<'_storage'>[] = [];
  for (const im of images) {
    const raw = (im as { fileId?: unknown } | null)?.fileId;
    const id = typeof raw === 'string' ? ctx.db.system.normalizeId('_storage', raw) : null;
    if (id) out.push(id);
  }
  return out;
}

async function dropFile(ctx: MutationCtx, id: Id<'_storage'> | undefined) {
  if (id) await ctx.storage.delete(id).catch(() => {});
}

/** Deletes up to the budget of rows a query gives, each after `before`. True when none are left. */
async function drain<T extends TableNames>(budget: Budget, page: (n: number) => Promise<Doc<T>[]>, del: (row: Doc<T>) => Promise<void>): Promise<boolean> {
  while (budget.left > 0) {
    const rows = await page(Math.min(budget.left, 100));
    if (!rows.length) return true;
    for (const r of rows) {
      await del(r);
      budget.left--;
    }
  }
  return false;
}

// ---------- one app

/**
 * Deletes one app's data for good, a budget at a time. 'wait': its machine is still being removed
 * (try again in a minute); 'more': the budget ran out.
 */
async function purgeAppStep(ctx: MutationCtx, app: Doc<'apps'>, budget: Budget, now: number): Promise<StepResult> {
  const threads = await ctx.db
    .query('threads')
    .withIndex('by_app', (q) => q.eq('appId', app._id))
    .collect();
  for (const t of threads) {
    // The machine first: a box or snapshot not gone yet is removed by boxes.retire, then we come back.
    const liveBox = await ctx.db
      .query('boxes')
      .withIndex('by_thread', (q) => q.eq('threadId', t._id))
      .filter((q) => q.eq(q.field('deletedAt'), undefined))
      .first();
    if (liveBox || t.snapshotId || (t.boxState !== 'deleted' && t.boxState !== 'none')) {
      await ctx.scheduler.runAfter(0, internal.boxes.retire, {
        threadId: t._id,
      });
      return 'wait';
    }
    const db = ctx.db;
    const steps: (() => Promise<boolean>)[] = [
      () =>
        drain<'messages'>(
          budget,
          (n) =>
            db
              .query('messages')
              .withIndex('by_thread_seq', (q) => q.eq('threadId', t._id))
              .take(n),
          async (r) => {
            for (const f of pictureIds(ctx, r.item)) await dropFile(ctx, f);
            await db.delete(r._id);
          },
        ),
      () =>
        drain<'inbox'>(
          budget,
          (n) =>
            db
              .query('inbox')
              .withIndex('by_thread_untaken', (q) => q.eq('threadId', t._id))
              .take(n),
          async (r) => {
            for (const f of pictureIds(ctx, r.payload)) await dropFile(ctx, f);
            await db.delete(r._id);
          },
        ),
      () =>
        drain<'workers'>(
          budget,
          (n) =>
            db
              .query('workers')
              .withIndex('by_thread_worker', (q) => q.eq('threadId', t._id))
              .take(n),
          (r) => db.delete(r._id),
        ),
      () =>
        drain<'pages'>(
          budget,
          (n) =>
            db
              .query('pages')
              .withIndex('by_thread_page', (q) => q.eq('threadId', t._id))
              .take(n),
          async (r) => {
            await dropFile(ctx, r.htmlFileId);
            await db.delete(r._id);
          },
        ),
      () =>
        drain<'signingTickets'>(
          budget,
          (n) =>
            db
              .query('signingTickets')
              .withIndex('by_thread', (q) => q.eq('threadId', t._id))
              .take(n),
          (r) => db.delete(r._id),
        ),
      () =>
        drain<'boxes'>(
          budget,
          (n) =>
            db
              .query('boxes')
              .withIndex('by_thread', (q) => q.eq('threadId', t._id))
              .take(n),
          (r) => db.delete(r._id),
        ),
    ];
    for (const s of steps) if (!(await s())) return 'more';
    if (budget.left <= 0) return 'more';
    await ctx.db.delete(t._id);
    budget.left--;
  }
  const db = ctx.db;
  const steps: (() => Promise<boolean>)[] = [
    () =>
      drain<'todos'>(
        budget,
        (n) =>
          db
            .query('todos')
            .withIndex('by_app', (q) => q.eq('appId', app._id))
            .take(n),
        (r) => db.delete(r._id),
      ),
    () =>
      drain<'builds'>(
        budget,
        (n) =>
          db
            .query('builds')
            .withIndex('by_app_number', (q) => q.eq('appId', app._id))
            .take(n),
        async (r) => {
          for (const f of r.files) await dropFile(ctx, f.fileId);
          await dropFile(ctx, r.otaFileId);
          await db.delete(r._id);
        },
      ),
    () =>
      drain<'signings'>(
        budget,
        (n) =>
          db
            .query('signings')
            .withIndex('by_app', (q) => q.eq('appId', app._id))
            .take(n),
        (r) => db.delete(r._id),
      ),
    () =>
      drain<'moves'>(
        budget,
        (n) =>
          db
            .query('moves')
            .withIndex('by_app', (q) => q.eq('appId', app._id))
            .take(n),
        (r) => db.delete(r._id),
      ),
    // The signing key is not deleted here: it waits out the grace period (sweep), and keeps the
    // app's name so the person can still save it (keysFor) after the app is gone.
    () =>
      drain<'keys'>(
        budget,
        (n) =>
          db
            .query('keys')
            .withIndex('by_app', (q) => q.eq('appId', app._id))
            .filter((q) => q.eq(q.field('deleteAfter'), undefined))
            .take(n),
        (r) => db.patch(r._id, { deleteAfter: now + PRIVACY.keyGraceDays * DAY, appName: app.name }),
      ),
  ];
  for (const s of steps) if (!(await s())) return 'more';
  if (budget.left <= 0) return 'more';
  await dropFile(ctx, app.iconFileId);
  await ctx.db.delete(app._id);
  budget.left--;
  return 'done';
}

/** Deletes a removed app for good once its undo window is over (scheduled by apps.remove; the hourly sweep catches any missed). */
export const purgeApp = internalMutation({
  args: { appId: v.id('apps') },
  handler: async (ctx, { appId }) => {
    const app = await ctx.db.get(appId);
    // Gone already, or brought back.
    if (!app || !app.deletedAt || !app.purgeAt) return;
    const now = Date.now();
    // Brought back and deleted again: that deletion has its own run, later.
    if (app.purgeAt > now) return;
    const r = await purgeAppStep(ctx, app, { left: STEP }, now);
    if (r === 'more') await ctx.scheduler.runAfter(0, internal.privacy.purgeApp, { appId });
    if (r === 'wait')
      await ctx.scheduler.runAfter(MINUTE, internal.privacy.purgeApp, {
        appId,
      });
  },
});

// ---------- the account

/** What "Delete my account" lists before the person confirms. */
export const summary = query({
  args: {},
  handler: async (ctx) => {
    let user;
    try {
      user = await requireUser(ctx);
    } catch {
      // Signed out, or the account is being deleted: the screen shows nothing more.
      return null;
    }
    const apps = (
      await ctx.db
        .query('apps')
        .withIndex('by_user', (q) => q.eq('userId', user._id))
        .collect()
    ).filter((a) => !a.deletedAt);
    const keys = await ctx.db
      .query('keys')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect();
    const withKey = new Set(keys.filter((k) => !k.deleteAfter).map((k) => String(k.appId)));
    const now = Date.now();
    const sub = await ctx.db
      .query('subscriptions')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .first();
    return {
      apps: apps.map((a) => ({
        id: a._id,
        name: a.name,
        place: a.place,
        hasKey: withKey.has(String(a._id)),
        repo: a.repo ?? null,
      })),
      plan:
        sub && sub.plan !== 'free' && sub.status !== 'cancelled'
          ? {
              name: PLANS[sub.plan].name,
              cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            }
          : null,
      // Keys of deleted apps that wait out the grace period: they can still be saved until then.
      keptKeys: keys.filter((k) => k.deleteAfter && k.deleteAfter > now).map((k) => ({ name: k.appName ?? k.packageName, packageName: k.packageName, until: k.deleteAfter! })),
      keyGraceDays: PRIVACY.keyGraceDays,
      appUndoMinutes: PRIVACY.appUndoMinutes,
      github: user.githubLogin ?? null,
    };
  },
});

/** The words the phone sends with the confirmation, so no stray call can delete an account. */
export const DELETE_WORDS = 'delete my account';

/**
 * "Delete my account", confirmed: the account is refused everywhere from now on, its PC links stop
 * working, and the deletion runs in the background (deleteAccountRun) until nothing is left.
 */
export const deleteAccount = mutation({
  args: { confirm: v.string() },
  handler: async (ctx, { confirm }) => {
    const user = await requireUser(ctx);
    if (confirm !== DELETE_WORDS) throw new Refused('Confirm the deletion first.');
    const now = Date.now();
    await ctx.db.patch(user._id, { deletingAt: now });
    for (const l of await ctx.db
      .query('pcLinks')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect()) {
      if (!l.revokedAt) await ctx.db.patch(l._id, { revokedAt: now });
    }
    for (const a of await ctx.db
      .query('apps')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect()) {
      await ctx.db.patch(a._id, {
        deletedAt: a.deletedAt ?? now,
        purgeAt: now,
      });
    }
    await ctx.scheduler.runAfter(0, internal.privacy.deleteAccountRun, {
      userId: user._id,
    });
    return { ok: true };
  },
});

/** How old an unfinished sign-up may get before it goes (sweepUnverified). */
export const UNVERIFIED_KEEP_MS = DAY;

/**
 * Sign-ups that never finished: asking for an email code makes a user row at once (Convex Auth),
 * so an address nobody confirmed would stay. A day later such a row goes, through the same
 * deletion as "Delete my account" (its login rows and old codes with it). Only rows with nothing
 * else: no verified email or phone, no session, no GitHub, no plan or customer, no apps, no PC.
 * Daily (crons.ts); at most 200 a run, the rest the next day.
 */
export const sweepUnverified = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - UNVERIFIED_KEEP_MS;
    const candidates = await ctx.db
      .query('users')
      .withIndex('by_email_verified', (q) => q.eq('emailVerificationTime', undefined))
      .filter((q) => q.lt(q.field('_creationTime'), cutoff))
      .take(200);
    let removed = 0;
    for (const u of candidates) {
      if (!u.email || u.phoneVerificationTime || u.isAnonymous || u.deletingAt) continue;
      if (u.githubLogin || u.githubInstallationId || u.stripeCustomerId || u.cloudSince) continue;
      const busy =
        (await ctx.db.query('authSessions').withIndex('userId', (q) => q.eq('userId', u._id)).first()) ||
        (await ctx.db.query('apps').withIndex('by_user', (q) => q.eq('userId', u._id)).first()) ||
        (await ctx.db.query('subscriptions').withIndex('by_user', (q) => q.eq('userId', u._id)).first()) ||
        (await ctx.db.query('pcLinks').withIndex('by_user', (q) => q.eq('userId', u._id)).first());
      if (busy) continue;
      // Someone back to finish signing in right now: their code still runs, so not this time.
      let codeLive = false;
      for (const a of await ctx.db.query('authAccounts').withIndex('userIdAndProvider', (q) => q.eq('userId', u._id)).collect()) {
        const codes = await ctx.db.query('authVerificationCodes').withIndex('accountId', (q) => q.eq('accountId', a._id)).collect();
        if (codes.some((c) => c.expirationTime > Date.now())) codeLive = true;
      }
      if (codeLive) continue;
      await ctx.db.patch(u._id, { deletingAt: Date.now() });
      await ctx.scheduler.runAfter(0, internal.privacy.deleteAccountRun, { userId: u._id });
      removed++;
    }
    if (removed) console.log(`unfinished sign-ups: ${removed} removed`);
    return { removed };
  },
});

export const accountState = internalQuery({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user || !user.deletingAt) return null;
    const threads = [];
    for (const a of await ctx.db
      .query('apps')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()) {
      threads.push(
        ...(await ctx.db
          .query('threads')
          .withIndex('by_app', (q) => q.eq('appId', a._id))
          .collect()),
      );
    }
    return {
      stripeCustomerId: user.stripeCustomerId ?? null,
      // Threads whose machine or snapshot is not gone yet.
      liveThreads: threads.filter((t) => t.boxId || t.snapshotId || (t.boxState !== 'deleted' && t.boxState !== 'none')).map((t) => t._id),
    };
  },
});

export const stripeGone = internalMutation({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (user) await ctx.db.patch(userId, { stripeCustomerId: undefined });
  },
});

/** The account's deletion, in order: Stripe, the machines, then the data. Runs again until done. */
export const deleteAccountRun = internalAction({
  args: { userId: v.id('users'), attempt: v.optional(v.number()) },
  handler: async (ctx, { userId, attempt = 0 }) => {
    const s = await ctx.runQuery(internal.privacy.accountState, { userId });
    if (!s) return;
    const again = () => ctx.scheduler.runAfter((Math.min(60, 2 ** attempt) * MINUTE) / 6, internal.privacy.deleteAccountRun, { userId, attempt: attempt + 1 });
    // 1. Payments: deleting the Stripe customer cancels the plan at once and removes the card.
    // Stripe keeps its own payment records (tax law); we keep none.
    if (s.stripeCustomerId) {
      try {
        await stripe('DELETE', `/customers/${encodeURIComponent(s.stripeCustomerId)}`);
      } catch (e) {
        if (!/No such customer/i.test((e as Error).message)) {
          console.error('account deletion, Stripe:', (e as Error).message);
          await again();
          return;
        }
      }
      await ctx.runMutation(internal.privacy.stripeGone, { userId });
    }
    // 2. Machines and snapshots.
    for (const threadId of s.liveThreads) {
      try {
        await ctx.runAction(internal.boxes.retire, { threadId });
      } catch (e) {
        console.error('account deletion, machine:', (e as Error).message);
        await again();
        return;
      }
    }
    // 3. The data, a step at a time.
    for (let i = 0; i < 40; i++) {
      const r = await ctx.runMutation(internal.privacy.purgeAccountStep, {
        userId,
      });
      if (r === 'done') return;
      if (r === 'wait') break;
    }
    await again();
  },
});

/** One step of an account's data going: its apps first, then every row about the person, the account last. */
export const purgeAccountStep = internalMutation({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }): Promise<StepResult> => {
    const user = await ctx.db.get(userId);
    if (!user) return 'done';
    if (!user.deletingAt) return 'done';
    const now = Date.now();
    const budget: Budget = { left: STEP };
    for (const app of await ctx.db
      .query('apps')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()) {
      const r = await purgeAppStep(ctx, app, budget, now);
      if (r !== 'done') return r;
    }
    const db = ctx.db;
    const del = (r: { _id: Id<TableNames> }) => db.delete(r._id);
    const steps: (() => Promise<boolean>)[] = [
      () =>
        drain<'subscriptions'>(
          budget,
          (n) =>
            db
              .query('subscriptions')
              .withIndex('by_user', (q) => q.eq('userId', userId))
              .take(n),
          del,
        ),
      () =>
        drain<'grants'>(
          budget,
          (n) =>
            db
              .query('grants')
              .withIndex('by_user_expires', (q) => q.eq('userId', userId))
              .take(n),
          del,
        ),
      () =>
        drain<'ledger'>(
          budget,
          (n) =>
            db
              .query('ledger')
              .withIndex('by_user_at', (q) => q.eq('userId', userId))
              .take(n),
          del,
        ),
      () =>
        drain<'balances'>(
          budget,
          (n) =>
            db
              .query('balances')
              .withIndex('by_user', (q) => q.eq('userId', userId))
              .take(n),
          del,
        ),
      () =>
        drain<'usage'>(
          budget,
          (n) =>
            db
              .query('usage')
              .withIndex('by_user_at', (q) => q.eq('userId', userId))
              .take(n),
          del,
        ),
      () =>
        drain<'changes'>(
          budget,
          (n) =>
            db
              .query('changes')
              .withIndex('by_user', (q) => q.eq('userId', userId))
              .take(n),
          del,
        ),
      () =>
        drain<'secrets'>(
          budget,
          (n) =>
            db
              .query('secrets')
              .withIndex('by_user_kind', (q) => q.eq('userId', userId))
              .take(n),
          del,
        ),
      () =>
        user.githubLogin
          ? drain<'githubTokens'>(
              budget,
              (n) =>
                db
                  .query('githubTokens')
                  .withIndex('by_login', (q) => q.eq('login', user.githubLogin!))
                  .take(n),
              del,
            )
          : Promise.resolve(true),
      () =>
        drain<'githubStates'>(
          budget,
          (n) =>
            db
              .query('githubStates')
              .filter((q) => q.eq(q.field('userId'), userId))
              .take(n),
          del,
        ),
      () =>
        drain<'pcHandoffs'>(
          budget,
          (n) =>
            db
              .query('pcHandoffs')
              .filter((q) => q.eq(q.field('userId'), userId))
              .take(n),
          del,
        ),
      () =>
        drain<'pcLinkRequests'>(
          budget,
          (n) =>
            db
              .query('pcLinkRequests')
              .filter((q) => q.eq(q.field('userId'), userId))
              .take(n),
          del,
        ),
      () =>
        drain<'pcLinks'>(
          budget,
          (n) =>
            db
              .query('pcLinks')
              .withIndex('by_user', (q) => q.eq('userId', userId))
              .take(n),
          del,
        ),
      () =>
        drain<'moves'>(
          budget,
          (n) =>
            db
              .query('moves')
              .withIndex('by_user_state', (q) => q.eq('userId', userId))
              .take(n),
          del,
        ),
      () =>
        drain<'boxes'>(
          budget,
          (n) =>
            db
              .query('boxes')
              .withIndex('by_user', (q) => q.eq('userId', userId))
              .take(n),
          del,
        ),
      () =>
        drain<'downloads'>(
          budget,
          (n) =>
            db
              .query('downloads')
              .withIndex('by_user', (q) => q.eq('userId', userId))
              .take(n),
          async (r) => {
            await dropFile(ctx, r.fileId);
            await db.delete(r._id);
          },
        ),
      // Keys of apps that were already gone keep their own date; any other key starts its grace period now.
      () =>
        drain<'keys'>(
          budget,
          (n) =>
            db
              .query('keys')
              .withIndex('by_user', (q) => q.eq('userId', userId))
              .filter((q) => q.eq(q.field('deleteAfter'), undefined))
              .take(n),
          (r) => db.patch(r._id, { deleteAfter: now + PRIVACY.keyGraceDays * DAY }),
        ),
      // Sign-in: sessions with their refresh tokens, then the linked sign-in methods with their codes.
      () =>
        drain<'authSessions'>(
          budget,
          (n) =>
            db
              .query('authSessions')
              .withIndex('userId', (q) => q.eq('userId', userId))
              .take(n),
          async (s) => {
            for (const r of await db
              .query('authRefreshTokens')
              .withIndex('sessionId', (q) => q.eq('sessionId', s._id))
              .collect())
              await db.delete(r._id);
            for (const r of await db
              .query('authVerifiers')
              .filter((q) => q.eq(q.field('sessionId'), s._id))
              .collect())
              await db.delete(r._id);
            await db.delete(s._id);
          },
        ),
      () =>
        drain<'authAccounts'>(
          budget,
          (n) =>
            db
              .query('authAccounts')
              .withIndex('userIdAndProvider', (q) => q.eq('userId', userId))
              .take(n),
          async (a) => {
            for (const r of await db
              .query('authVerificationCodes')
              .withIndex('accountId', (q) => q.eq('accountId', a._id))
              .collect())
              await db.delete(r._id);
            await db.delete(a._id);
          },
        ),
    ];
    for (const s of steps) if (!(await s())) return 'more';
    if (budget.left <= 0) return 'more';
    await ctx.db.delete(userId);
    return 'done';
  },
});

// ---------- timers

/** Hourly: apps whose undo window ended (a missed scheduled purge), expired downloads, keys past their grace. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query('apps')
      .withIndex('by_purge', (q) => q.gt('purgeAt', 0).lte('purgeAt', now))
      .take(20);
    for (const a of due)
      if (a.deletedAt)
        await ctx.scheduler.runAfter(0, internal.privacy.purgeApp, {
          appId: a._id,
        });
    for (const d of await ctx.db
      .query('downloads')
      .withIndex('by_expiry', (q) => q.lte('expiresAt', now))
      .take(100)) {
      await dropFile(ctx, d.fileId);
      await ctx.db.delete(d._id);
    }
    const keys = await ctx.db
      .query('keys')
      .withIndex('by_delete_after', (q) => q.gt('deleteAfter', 0).lte('deleteAfter', now))
      .take(100);
    for (const k of keys) {
      // Its tickets and signing log went with the app; the key itself goes now.
      await ctx.db.delete(k._id);
    }
    return { apps: due.length, keys: keys.length };
  },
});

/**
 * Keeps the files of an app's newest PRIVACY.keepBuilds builds; older builds keep their row (the
 * version's number and notes) without files. Called after each build and by the daily sweep.
 */
export async function pruneBuilds(ctx: MutationCtx, appId: Id<'apps'>) {
  const all = await ctx.db
    .query('builds')
    .withIndex('by_app_number', (q) => q.eq('appId', appId))
    .order('desc')
    .collect();
  let removed = 0;
  for (const old of all.slice(PRIVACY.keepBuilds)) {
    if (!old.files.length && !old.otaFileId) continue;
    for (const f of old.files) await dropFile(ctx, f.fileId);
    await dropFile(ctx, old.otaFileId);
    await ctx.db.patch(old._id, { files: [], otaFileId: undefined });
    removed++;
  }
  return removed;
}

/** Daily: old build files of every app (apps made before builds were pruned on arrival), a page at a time. */
export const sweepBuilds = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('apps').paginate({ numItems: 50, cursor: cursor ?? null });
    let removed = 0;
    for (const a of page.page) removed += await pruneBuilds(ctx, a._id);
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.privacy.sweepBuilds, {
        cursor: page.continueCursor,
      });
    return removed;
  },
});

// ---------- downloads

/** Records a file made for the person and returns its one-time link (the token is never stored). */
export const recordDownload = internalMutation({
  args: {
    userId: v.id('users'),
    kind: v.union(v.literal('data'), v.literal('keys')),
    fileId: v.id('_storage'),
    fileName: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
  },
  handler: async (ctx, a) => {
    const token = randomToken();
    const expiresAt = Date.now() + PRIVACY.downloadMinutes * MINUTE;
    await ctx.db.insert('downloads', {
      ...a,
      tokenHash: await sha256Hex(token),
      expiresAt,
    });
    return {
      url: `${process.env.CONVEX_SITE_URL}/download/${token}`,
      expiresAt,
      fileName: a.fileName,
      sizeBytes: a.sizeBytes,
    };
  },
});

/** The person's newest download of a kind (to refuse a second one made within a minute). */
export const lastDownload = internalQuery({
  args: {
    userId: v.id('users'),
    kind: v.union(v.literal('data'), v.literal('keys')),
  },
  handler: async (ctx, { userId, kind }) => {
    const rows = await ctx.db
      .query('downloads')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    return rows.filter((r) => r.kind === kind).sort((a, b) => b._creationTime - a._creationTime)[0] ?? null;
  },
});

export const downloadByHash = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) =>
    ctx.db
      .query('downloads')
      .withIndex('by_hash', (q) => q.eq('tokenHash', tokenHash))
      .first(),
});

/** GET /download/<token>: the file, as an attachment, while its link lives. */
export const downloadRoute = httpAction(async (ctx, req) => {
  const token = new URL(req.url).pathname.split('/').pop() ?? '';
  const gone = () =>
    new Response(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link ended</title><body style="font-family:system-ui,sans-serif;padding:32px;max-width:520px;margin:auto"><h1>This link has ended</h1><p>Download links work for a short time. Ask for the file again in Kiwimake.</p>',
      {
        status: 410,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      },
    );
  if (token.length < 20) return gone();
  const row = await ctx.runQuery(internal.privacy.downloadByHash, {
    tokenHash: await sha256Hex(token),
  });
  if (!row || row.expiresAt <= Date.now()) return gone();
  const blob = await ctx.storage.get(row.fileId);
  if (!blob) return gone();
  return new Response(blob, {
    status: 200,
    headers: {
      'Content-Type': row.mimeType,
      'Content-Disposition': `attachment; filename="${row.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

// ---------- what the downloads read (privacyNode.ts builds the files)

/** The account's own rows for "Download my data" (never a secret: an AI key shows as its last 4 characters). */
export const dataAccount = internalQuery({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user) return null;
    const sub = await ctx.db
      .query('subscriptions')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .first();
    const balance = await ctx.db
      .query('balances')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .first();
    const grants = await ctx.db
      .query('grants')
      .withIndex('by_user_expires', (q) => q.eq('userId', userId))
      .collect();
    const links = await ctx.db
      .query('pcLinks')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    const ownKey = await ctx.db
      .query('secrets')
      .withIndex('by_user_kind', (q) => q.eq('userId', userId).eq('kind', 'anthropic'))
      .first();
    const accounts = await ctx.db
      .query('authAccounts')
      .withIndex('userIdAndProvider', (q) => q.eq('userId', userId))
      .collect();
    const apps = await ctx.db
      .query('apps')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    const iso = (t?: number) => (t ? new Date(t).toISOString() : null);
    return {
      account: {
        id: user._id,
        createdAt: iso(user._creationTime),
        name: user.name ?? null,
        email: user.email ?? null,
        signInWith: accounts.map((a) => a.provider),
        cloudSince: iso(user.cloudSince),
        useCloudWhenPcIsOff: Boolean(user.pcOffSwitch),
        aiMode: user.aiMode ?? 'credit',
        github: user.githubLogin ? { login: user.githubLogin, connected: !user.githubDisconnectedAt } : null,
        ownAnthropicKey: ownKey ? { endsWith: ownKey.last4 ?? '' } : null,
        payments: user.stripeCustomerId ? 'Handled by Stripe; receipts are in Manage plan.' : null,
      },
      plan: sub
        ? {
            plan: PLANS[sub.plan].name,
            interval: sub.interval,
            status: sub.status,
            periodStart: iso(sub.periodStart),
            periodEnd: iso(sub.periodEnd),
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          }
        : { plan: 'Free' },
      credits: {
        balance: (balance?.millicredits ?? 0) / 1000,
        grants: grants.map((g) => ({
          source: g.source,
          credits: g.millicredits / 1000,
          left: g.remaining / 1000,
          grantedAt: iso(g.grantedAt),
          expiresAt: iso(g.expiresAt),
        })),
      },
      linkedPcs: links.map((l) => ({
        name: l.deviceName,
        linkedFrom: l.linkedFrom,
        createdAt: iso(l.createdAt),
        lastSeenAt: iso(l.lastSeenAt),
        revokedAt: iso(l.revokedAt),
      })),
      apps: apps
        .filter((a) => !a.deletedAt)
        .map((a) => ({
          id: a._id,
          name: a.name,
          slug: a.slug,
          packageName: a.packageName,
          place: a.place,
          preset: a.preset ?? 'react-native',
          createdAt: iso(a._creationTime),
          updatedAt: iso(a.updatedAt),
          firstMessage: a.prompt ?? null,
          overview: a.overview ?? null,
          repo: a.repo ?? null,
          latestVersion: (a.latestBuild as { number?: number } | undefined)?.number ?? null,
          iconFileId: a.iconFileId ?? null,
        })),
    };
  },
});

/** One app's chat (and helper chats), to-dos, pages, builds and changes, a page of messages at a time. */
export const dataApp = internalQuery({
  args: {
    userId: v.id('users'),
    appId: v.id('apps'),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { userId, appId, cursor }) => {
    const app = await ctx.db.get(appId);
    if (!app || app.userId !== userId) return null;
    const thread = await ctx.db
      .query('threads')
      .withIndex('by_app', (q) => q.eq('appId', appId))
      .first();
    const page = thread
      ? await ctx.db
          .query('messages')
          .withIndex('by_thread_seq', (q) => q.eq('threadId', thread._id))
          .paginate({ numItems: 400, cursor: cursor ?? null })
      : { page: [], isDone: true, continueCursor: '' };
    const messages = page.page.map((m) => ({
      workerId: m.workerId ?? null,
      seq: m.seq,
      item: m.item,
    }));
    if (cursor)
      return {
        messages,
        isDone: page.isDone,
        cursor: page.continueCursor,
        rest: null,
      };
    const iso = (t?: number) => (t ? new Date(t).toISOString() : null);
    const todos = await ctx.db
      .query('todos')
      .withIndex('by_app', (q) => q.eq('appId', appId))
      .collect();
    const pages = thread
      ? await ctx.db
          .query('pages')
          .withIndex('by_thread_page', (q) => q.eq('threadId', thread._id))
          .collect()
      : [];
    const workers = thread
      ? await ctx.db
          .query('workers')
          .withIndex('by_thread_worker', (q) => q.eq('threadId', thread._id))
          .collect()
      : [];
    const builds = await ctx.db
      .query('builds')
      .withIndex('by_app_number', (q) => q.eq('appId', appId))
      .collect();
    const changes = await ctx.db
      .query('changes')
      .withIndex('by_app_at', (q) => q.eq('appId', appId))
      .collect();
    const key = await ctx.db
      .query('keys')
      .withIndex('by_app', (q) => q.eq('appId', appId))
      .first();
    return {
      messages,
      isDone: page.isDone,
      cursor: page.continueCursor,
      rest: {
        todos: todos.map((t) => ({
          text: t.text,
          done: t.done,
          at: iso(t.at),
        })),
        helpers: workers.map((w) => w.info),
        pages: pages.map((p) => ({
          pageId: p.pageId,
          info: p.info,
          answers: p.answers ?? null,
          htmlFileId: p.htmlFileId ?? null,
        })),
        versions: builds.map((b) => ({
          number: b.number,
          delivery: b.delivery,
          commit: b.commit ?? null,
          notes: (b.info as { changes?: unknown } | undefined)?.changes ?? null,
        })),
        changes: changes.map((c) => ({
          startedAt: iso(c.startedAt),
          endedAt: iso(c.endedAt),
          state: c.state,
          credits: c.actual.millicredits / 1000,
          estimate: c.estimate ? { low: c.estimate.low / 1000, high: c.estimate.high / 1000 } : null,
        })),
        signingKey: key
          ? {
              certSha256: key.certSha256,
              since: iso(key.at),
              note: 'The key itself is not in this file: save it with "Save signing keys".',
            }
          : null,
      },
    };
  },
});

/** The sealed keys of the person's apps (or the given ones), for the key file. */
export const keysFor = internalQuery({
  args: { userId: v.id('users'), appIds: v.optional(v.array(v.string())) },
  handler: async (ctx, { userId, appIds }) => {
    const user = await ctx.db.get(userId);
    if (!user || user.blocked || user.deletingAt) return null;
    const now = Date.now();
    const keys = (
      await ctx.db
        .query('keys')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect()
    ).filter((k) => !appIds || appIds.includes(String(k.appId)));
    const out = [];
    for (const key of keys) {
      const app = await ctx.db.get(key.appId);
      // A live app's key; a deleted app's while it can still be brought back; and once the app is
      // gone, its key until the grace period ends.
      if (app ? app.deletedAt && (!app.purgeAt || app.purgeAt <= now) : !key.deleteAfter || key.deleteAfter <= now) continue;
      out.push({
        appId: String(key.appId),
        name: app?.name ?? key.appName ?? key.packageName,
        packageName: key.packageName,
        certSha256: key.certSha256,
        at: key.at,
        envelope: {
          wrappedDataKey: key.wrappedDataKey,
          iv: key.iv,
          ciphertext: key.ciphertext,
          kekVersion: key.kekVersion,
        },
        // As signing.ts sealed it: the app's id and package name, which the key row keeps too.
        aad: `appkey:${key.appId}:${app?.packageName ?? key.packageName}`,
        lineage: key.lineage ?? null,
      });
    }
    return out;
  },
});

// ---------- dev only

/**
 * Dev (KIWI_ALLOW_WIPE=1): gives a test account a cloud app with a chat (and a picture), a page,
 * a to-do, five builds with files and a signing key, so deleting and downloading can be proven on
 * the dev deployment without a GitHub connection or a paid build. The key is a throwaway one.
 */
export const devSeedApp = internalMutation({
  args: { userId: v.optional(v.id('users')), name: v.string(), p12: v.string(), storePassword: v.string(), certSha256: v.string() },
  handler: async (ctx, args) => {
    if (process.env.KIWI_ALLOW_WIPE !== '1') throw new Error('dev only');
    const now = Date.now();
    // No user given: the newest test (anonymous) account, made in the last hour (the phone's).
    const newest = args.userId
      ? null
      : await ctx.db
          .query('users')
          .order('desc')
          .filter((q) => q.eq(q.field('isAnonymous'), true))
          .first();
    const userId = args.userId ?? (newest && now - newest._creationTime < 3600_000 ? newest._id : null);
    if (!userId) throw new Error('no test account');
    const a = { ...args, userId };
    const iso = new Date(now).toISOString();
    const slug =
      a.name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 30) || 'app';
    const packageName = `com.anyappcloud.${slug}`;
    const file = (s: string, type = 'application/octet-stream') => ctx.storage.store(new Blob([s], { type }));
    const appId = await ctx.db.insert('apps', {
      userId: a.userId,
      name: a.name,
      slug,
      packageName,
      place: 'cloud',
      buildHigh: 5,
      iconVersion: 0,
      status: 'idle',
      prompt: `A ${a.name.toLowerCase()} for the deletion proof`,
      lastMessagePreview: 'Make the button green',
      updatedAt: now,
    });
    const threadId = await ctx.db.insert('threads', { appId, userId: a.userId, boxState: 'none', lastActiveAt: now, seq: 4 });
    const picture = await file('a picture', 'image/jpeg');
    const rows = [
      { id: 'u1', kind: 'user', text: `Make me a ${a.name.toLowerCase()}`, createdAt: iso },
      { id: 'a1', kind: 'assistant', text: `Here is ${a.name}: one big button that counts.`, createdAt: iso },
      { id: 'u2', kind: 'user', text: 'Make the button green', images: [{ fileId: picture, mimeType: 'image/jpeg' }], createdAt: iso },
    ];
    for (const [i, item] of rows.entries())
      await ctx.db.insert('messages', { threadId, itemId: item.id, seq: i + 1, item: { ...item, appId, seq: i + 1, updatedAt: iso }, updatedAt: now });
    await ctx.db.insert('pages', { threadId, pageId: 'plan-1', info: { title: 'The plan' }, htmlFileId: await file('<h1>The plan</h1>', 'text/html') });
    await ctx.db.insert('todos', { appId, text: 'Add a reset button', done: false, at: now });
    for (let n = 1; n <= 5; n++) {
      const fileId = await file(`apk ${n}`);
      await ctx.db.insert('builds', { appId, number: n, delivery: 'apk', files: [{ abi: 'x86_64', fileId, sizeBytes: 5, sha256: 'x' }], info: { number: n }, pushed: false });
    }
    const payload = new TextEncoder().encode(JSON.stringify({ p12: a.p12, storePassword: a.storePassword, keyAlias: 'app' }));
    const e = await envelopeSeal(payload, `appkey:${appId}:${packageName}`);
    await ctx.db.insert('keys', { appId, userId: a.userId, packageName, certSha256: a.certSha256, ...e, at: now });
    return { appId, packageName, userId };
  },
});

/** Dev: what is left of an account and its apps, as counts (the deletion proof). */
export const devCountsFor = internalQuery({
  args: { userId: v.string(), appIds: v.array(v.string()) },
  handler: async (ctx, { userId, appIds }) => {
    if (process.env.KIWI_ALLOW_WIPE !== '1') throw new Error('dev only');
    const uid = ctx.db.normalizeId('users', userId);
    const by = async (table: string, field: string, value: unknown) =>
      (
        await ctx.db
          .query(table as never)
          .filter((q) => q.eq(q.field(field as never), value as never))
          .collect()
      ).length;
    const out: Record<string, number> = { users: uid && (await ctx.db.get(uid)) ? 1 : 0 };
    for (const t of ['subscriptions', 'balances', 'grants', 'ledger', 'usage', 'changes', 'secrets', 'pcLinks', 'downloads', 'authSessions', 'authAccounts'])
      out[t] = await by(t, 'userId', userId);
    let threads = 0;
    let messages = 0;
    for (const id of appIds) {
      const appId = ctx.db.normalizeId('apps', id);
      out.apps = (out.apps ?? 0) + (appId && (await ctx.db.get(appId)) ? 1 : 0);
      out.builds = (out.builds ?? 0) + (await by('builds', 'appId', id));
      out.todos = (out.todos ?? 0) + (await by('todos', 'appId', id));
      for (const t of await ctx.db
        .query('threads')
        .filter((q) => q.eq(q.field('appId'), id as never))
        .collect()) {
        threads++;
        messages += await by('messages', 'threadId', t._id);
      }
      const keys = await ctx.db
        .query('keys')
        .filter((q) => q.eq(q.field('appId'), id as never))
        .collect();
      out.keys = (out.keys ?? 0) + keys.length;
      out.keysWithDeleteDate = (out.keysWithDeleteDate ?? 0) + keys.filter((k) => k.deleteAfter).length;
    }
    return { ...out, threads, messages };
  },
});
