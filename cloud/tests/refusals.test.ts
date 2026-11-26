// Refusals written for people reach the apps in production too: they are ConvexErrors (Refused,
// convex/lib/refused.ts), whose text a production deployment passes on as `data`; a plain Error's
// text is hidden there ("Server Error").
import fs from 'node:fs';
import path from 'node:path';
import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import schema from '../convex/schema';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { Refused } from '../convex/lib/refused';

const modules = import.meta.glob('../convex/**/*.*s');

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('RUNNER_POLL_MS', '0');
});

async function refusal(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal');
}

describe('refusals for people', () => {
  test('Refused is a ConvexError whose data is the sentence', () => {
    const e = new Refused('Write a message first.');
    expect(e).toBeInstanceOf(ConvexError);
    expect(e.data).toBe('Write a message first.');
    expect(e.message).toBe('Write a message first.');
  });

  test('signed out, an empty message, and the credit gate come back as data', async () => {
    const t = convexTest(schema, modules);
    const signedOut = await refusal(t.mutation(api.github.connectUrl, {}));
    expect((signedOut as ConvexError<string>).data).toBe('Sign in first.');
    const userId = await t.run((ctx) => ctx.db.insert('users', { email: 'a@example.com', githubLogin: 'a', githubInstallationId: '1' }));
    const as = t.withIdentity({ subject: `${userId}|s` });
    const appId = (await as.mutation(api.apps.create, { name: 'Tip Split', prompt: 'tips' })) as Id<'apps'>;
    const empty = await refusal(as.mutation(api.chat.send, { appId, text: '   ' }));
    expect((empty as ConvexError<string>).data).toBe('Write a message first.');
    await t.run(async (ctx) => {
      for (const g of await ctx.db.query('grants').collect()) await ctx.db.patch(g._id, { remaining: 0 });
      const b = (await ctx.db.query('balances').first())!;
      await ctx.db.patch(b._id, { millicredits: 0 });
      const sub = (await ctx.db.query('subscriptions').first())!;
      await ctx.db.patch(sub._id, { firstAppDone: true });
      await ctx.db.patch(appId, { buildHigh: 1 });
      for (const c of await ctx.db.query('changes').collect()) await ctx.db.patch(c._id, { state: 'done' });
    });
    const gate = await refusal(as.mutation(api.chat.send, { appId, text: 'more' }));
    expect((gate as ConvexError<string>).data).toMatch(/^This change needs about .* credits and you have 0\. Get extra credit or a plan to go on\.$/);
  });

  test('no sentence for people is thrown as a plain Error (production would hide it)', () => {
    const dir = path.join(__dirname, '..', 'convex');
    const files = [...fs.readdirSync(dir).map((f) => path.join(dir, f)), ...fs.readdirSync(path.join(dir, 'lib')).map((f) => path.join(dir, 'lib', f))].filter((f) => f.endsWith('.ts') && !f.includes('_generated'));
    // Internal ones that read like sentences: a PC's own wrong call, and a setup mistake.
    const internal = ['Not a move to the cloud.', 'Only a Stripe test key may be used here.'];
    const found: string[] = [];
    for (const f of files) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/throw new Error\(\s*'([A-Z][a-z][^']*\.)'\s*\)/g)) {
        if (!internal.includes(m[1]!)) found.push(`${path.basename(f)}: ${m[1]}`);
      }
    }
    expect(found).toEqual([]);
  });
});
