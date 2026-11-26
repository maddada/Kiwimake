'use node';
// The two files a person can download (docs/CLOUD.md section 6, "Deleting an app, an account, and
// downloading your data"), made in Node (zip, scrypt, room for code archives) and handed over by a
// one-time link (privacy.recordDownload, /download/<token>):
// - "Download my data": one zip with the account, and per app its chat, to-dos, pages, pictures,
//   versions, what each change used, and its code from the person's GitHub.
// - "Save signing keys": the apps' signing keys in the desktop's key backup format
//   (builder/lib/keybackup.mjs, a .anyappkeys file locked with a password the person picks), so
//   Kiwimake on a PC restores them (Settings, Signing keys, Restore) and keeps updating the apps.
import crypto from 'node:crypto';
import { zipSync, strToU8, type Zippable } from 'fflate';
import { getAuthUserId } from '@convex-dev/auth/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { action, type ActionCtx } from './_generated/server';
import { envelopeOpen } from './lib/crypto';
import { Refused } from './lib/refused';

type Link = { url: string; expiresAt: number; fileName: string; sizeBytes: number };

async function signedIn(ctx: ActionCtx): Promise<Id<'users'>> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Refused('Sign in first.');
  const user = await ctx.runQuery(internal.stripe.userRow, { userId });
  if (!user || user.blocked || user.deletingAt) throw new Refused('Sign in first.');
  return userId;
}

/** One a minute of each kind: making the data file reads everything the account has. */
async function notTooSoon(ctx: ActionCtx, userId: Id<'users'>, kind: 'data' | 'keys') {
  const last = await ctx.runQuery(internal.privacy.lastDownload, { userId, kind });
  if (last && Date.now() - last._creationTime < 60_000) throw new Refused('Your file was made a moment ago. Try again in a minute.');
}

const day = () => new Date().toISOString().slice(0, 10);
const json = (x: unknown) => strToU8(`${JSON.stringify(x, null, 2)}\n`);
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'app';

/** The main chat as plain text: who said what, in order (the full rows are in chat.json). */
function transcript(messages: { workerId: string | null; item: any }[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.workerId) continue;
    const it = m.item ?? {};
    const text = typeof it.text === 'string' ? it.text.trim() : '';
    if (!text || (it.kind !== 'user' && it.kind !== 'assistant')) continue;
    lines.push(`${it.kind === 'user' ? 'You' : 'Kiwimake'} (${String(it.createdAt ?? '').slice(0, 16).replace('T', ' ')} UTC):`, text, '');
  }
  return lines.join('\n');
}

async function fileBytes(ctx: ActionCtx, id: string): Promise<Uint8Array | null> {
  try {
    const blob = await ctx.storage.get(id as Id<'_storage'>);
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** The app's code from the person's GitHub (the repo's default branch as GitHub zips it), or why not. */
async function codeOf(ctx: ActionCtx, appId: string, repo: string | null): Promise<{ zip?: Uint8Array; note?: string }> {
  if (!repo) return { note: 'This app has no code on GitHub yet.' };
  try {
    const t = await ctx.runAction(internal.github.repoTokenForApp, { appId: appId as Id<'apps'> });
    if ('error' in t) return { note: `Your code is at https://github.com/${repo}. It could not be added here: ${t.error}.` };
    const res = await fetch(`https://api.github.com/repos/${repo}/zipball`, {
      headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'kiwimake-cloud' },
    });
    if (!res.ok) return { note: `Your code is at https://github.com/${repo}. GitHub answered ${res.status}, so it is not in this file.` };
    return { zip: new Uint8Array(await res.arrayBuffer()) };
  } catch (e) {
    return { note: `Your code is at https://github.com/${repo}. It could not be added here: ${(e as Error).message.slice(0, 160)}.` };
  }
}

const README = (when: string) => `Your Kiwimake data, ${when}

account.json      Your account: sign-in, plan, credits, linked PCs, the apps you have.
apps/<name>/      One folder per app:
  app.json        Its name, package, first message and overview.
  chat.txt        The chat with its agent, as text.
  chat.json       Every chat row (with helpers' own chats), as Kiwimake keeps them.
  todos.json      Your to-do list for it.
  pages/          The pages its agent showed you, and your answers (in app.json).
  pictures/       Pictures you sent in its chat.
  versions.json   Its versions, and what each change used in credits.
  code.zip        Its code, from your GitHub (or code.txt saying where it is).

Not in this file: the apps' signing keys (save them with "Save signing keys" in Kiwimake), your
own AI key (only its last 4 characters), and card details (Stripe keeps them; receipts are in
Manage plan).
`;

/** "Download my data": builds the zip and returns its one-time link. */
export const myData = action({
  args: {},
  handler: async (ctx): Promise<Link> => {
    const userId = await signedIn(ctx);
    await notTooSoon(ctx, userId, 'data');
    const acc = await ctx.runQuery(internal.privacy.dataAccount, { userId });
    if (!acc) throw new Refused('Sign in first.');
    const files: Zippable = { 'README.txt': strToU8(README(new Date().toISOString())), 'account.json': json({ ...acc, apps: acc.apps.map(({ iconFileId: _i, ...a }) => a) }) };
    const used = new Set<string>();
    for (const a of acc.apps) {
      let dir = safeName(a.name);
      for (let n = 2; used.has(dir); n++) dir = `${safeName(a.name)}-${n}`;
      used.add(dir);
      const first = await ctx.runQuery(internal.privacy.dataApp, { userId, appId: a.id });
      const rest = first?.rest;
      if (!first || !rest) continue;
      const messages = [...first.messages];
      let cursor = first.cursor;
      let done = first.isDone;
      while (!done) {
        const next = await ctx.runQuery(internal.privacy.dataApp, { userId, appId: a.id, cursor });
        if (!next) break;
        messages.push(...next.messages);
        cursor = next.cursor;
        done = next.isDone;
      }
      const f: Zippable = {};
      f['app.json'] = json({ ...a, iconFileId: undefined, pages: rest.pages.map(({ htmlFileId: _h, ...p }) => p), helpers: rest.helpers, signingKey: rest.signingKey });
      f['chat.txt'] = strToU8(transcript(messages));
      f['chat.json'] = json(messages);
      f['todos.json'] = json(rest.todos);
      f['versions.json'] = json({ versions: rest.versions, changes: rest.changes });
      if (a.iconFileId) {
        const icon = await fileBytes(ctx, a.iconFileId);
        if (icon) f['icon.png'] = [icon, { level: 0 }];
      }
      const pages: Zippable = {};
      for (const p of rest.pages) {
        const html = p.htmlFileId ? await fileBytes(ctx, p.htmlFileId) : null;
        if (html) pages[`${safeName(p.pageId)}.html`] = html;
      }
      if (Object.keys(pages).length) f.pages = pages;
      const pictures: Zippable = {};
      const seen = new Set<string>();
      for (const m of messages) {
        for (const im of (m.item?.images ?? []) as { fileId?: string; mimeType?: string }[]) {
          if (!im?.fileId || seen.has(im.fileId)) continue;
          seen.add(im.fileId);
          const bytes = await fileBytes(ctx, im.fileId);
          if (bytes) pictures[`${safeName(im.fileId)}.${/png/.test(im.mimeType ?? '') ? 'png' : 'jpg'}`] = [bytes, { level: 0 }];
        }
      }
      if (Object.keys(pictures).length) f.pictures = pictures;
      const code = await codeOf(ctx, a.id, a.repo);
      if (code.zip) f['code.zip'] = [code.zip, { level: 0 }];
      else f['code.txt'] = strToU8(`${code.note}\n`);
      files[`apps/${dir}`] = f;
    }
    const zip = zipSync(files, { level: 6 });
    const fileId = await ctx.storage.store(new Blob([zip], { type: 'application/zip' }));
    return ctx.runMutation(internal.privacy.recordDownload, { userId, kind: 'data', fileId, fileName: `kiwimake-data-${day()}.zip`, mimeType: 'application/zip', sizeBytes: zip.length });
  },
});

// The desktop's key backup format (builder/lib/keybackup.mjs): the same header, scrypt and AES-256-GCM.
const BACKUP_FORMAT = 'anyappagent-signing-keys';
const SCRYPT = { N: 2 ** 16, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
export const MIN_PASSWORD = 8;

export function lockKeys(entries: unknown[], password: string, createdAt = new Date().toISOString()) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const header = { format: BACKUP_FORMAT, version: 1, createdAt, count: entries.length };
  const key = crypto.scryptSync(password.normalize('NFC'), salt, 32, SCRYPT);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(header), 'utf8'));
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify({ keys: entries }), 'utf8')), cipher.final()]);
  return {
    ...header,
    kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    data: data.toString('base64'),
  };
}

/**
 * "Save signing keys": the keys of the person's apps (all, or the ones given), opened from their
 * envelopes here only, locked with the person's password, as a .anyappkeys file behind a one-time link.
 */
export const signingKeys = action({
  args: { password: v.string(), appIds: v.optional(v.array(v.string())) },
  handler: async (ctx, { password, appIds }): Promise<Link & { count: number }> => {
    const userId = await signedIn(ctx);
    if (password.length < MIN_PASSWORD) throw new Refused(`Pick a password of at least ${MIN_PASSWORD} characters.`);
    await notTooSoon(ctx, userId, 'keys');
    const keys = await ctx.runQuery(internal.privacy.keysFor, { userId, ...(appIds ? { appIds } : {}) });
    if (!keys?.length) throw new Refused('None of your apps has a signing key yet.');
    const entries = [];
    for (const k of keys) {
      const plain = await envelopeOpen(k.envelope, k.aad);
      const inner = JSON.parse(new TextDecoder().decode(plain)) as { p12: string; storePassword: string; keyAlias: string };
      plain.fill(0);
      entries.push({
        id: k.packageName,
        // As builder/lib/keystore.mjs keeps an app's key.json (a PKCS12 key has one password).
        info: { kind: 'own', packageName: k.packageName, storePassword: inner.storePassword, keyAlias: inner.keyAlias, keyPassword: inner.storePassword, certSha256: k.certSha256, createdAt: new Date(k.at).toISOString(), appName: k.name },
        files: { store: inner.p12 },
      });
    }
    const text = JSON.stringify(lockKeys(entries, password), null, 2);
    const bytes = new TextEncoder().encode(text);
    const fileId = await ctx.storage.store(new Blob([bytes], { type: 'application/octet-stream' }));
    const one = keys.length === 1 ? `-${safeName(keys[0].name).toLowerCase()}` : '';
    const link = await ctx.runMutation(internal.privacy.recordDownload, { userId, kind: 'keys', fileId, fileName: `kiwimake-signing-keys${one}-${day()}.anyappkeys`, mimeType: 'application/octet-stream', sizeBytes: bytes.length });
    return { ...link, count: keys.length };
  },
});
