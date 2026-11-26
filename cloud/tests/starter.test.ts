// Running on Convex Starter (docs/CLOUD.md section 3, "Running on Convex Starter"): errors go to Sentry
// ourselves (scrubbed), an uptime check, and the deployment's own address carrying Google's
// verification tag.
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import schema from '../convex/schema';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { sha256Hex } from '../convex/lib/crypto';
import { envelope, parseDsn, reportError, reportOf, scrub, sendReport } from '../convex/lib/errors';
import { rootPage } from '../convex/http';

const modules = import.meta.glob('../convex/**/*.*s');
const DSN = 'https://abc123public@o42.ingest.sentry.io/4507';

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('RUNNER_POLL_MS', '0');
});
afterEach(() => vi.unstubAllGlobals());

describe('Sentry without an SDK', () => {
  test('the DSN becomes the envelope URL and key; a bad one sends nothing', () => {
    expect(parseDsn(DSN)).toEqual({ url: 'https://o42.ingest.sentry.io/api/4507/envelope/', publicKey: 'abc123public', dsn: DSN });
    expect(parseDsn(undefined)).toBeNull();
    expect(parseDsn('http://k@host/1')).toBeNull();
    expect(parseDsn('https://host/1')).toBeNull();
    expect(parseDsn('not a url')).toBeNull();
  });

  test('secrets and email addresses never leave in a report', () => {
    const text = [
      'Stripe sk_live_abcdef123 and whsec_abc+/=, rk_test_1',
      'Anthropic sk-ant-api03-xyz, DeepSeek sk-0123456789abcdef0123456789, OpenRouter sk-or-v1-abc',
      'GitHub ghs_abcdefghijklmnopqrstuvwxyz, github_pat_11AB_cd, Instabox ibk_live_1 ibsec_2',
      'Resend re_abcdefghijklmnopqrst, link kpc_abc, deploy prod:happy-otter-1|eyJ2abc',
      'Authorization: Bearer abc.def.ghi, jwt eyJhbGciOi.eyJzdWIi.c2lnbmF0dXJl',
      'mail a.person+x@example.com',
      '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----',
    ].join('\n');
    const out = scrub(text);
    for (const bad of ['sk_live_abcdef123', 'whsec_abc', 'sk-ant-api03', 'sk-0123456789abcdef', 'sk-or-v1', 'ghs_abc', 'github_pat_', 'ibk_live', 'ibsec_2', 're_abcdefghij', 'kpc_abc', 'happy-otter-1|', 'Bearer abc', 'eyJhbGciOi', 'example.com', 'MIIE']) {
      expect(out).not.toContain(bad);
    }
    expect(scrub('x'.repeat(5000)).length).toBe(2000);
  });

  test('an envelope: header, item, event with where, level and scrubbed text', () => {
    vi.stubEnv('SENTRY_ENVIRONMENT', 'production');
    vi.stubEnv('SENTRY_RELEASE', 'cloud@1');
    const e = new TypeError('refresh refused for sk-ant-abc');
    const lines = envelope(parseDsn(DSN)!, reportOf(e, '/runner/github-token', { route: 'runner', 'Bad Tag': 'x' }), new Date('2026-11-27T00:00:00Z')).split('\n');
    expect(lines).toHaveLength(3);
    const head = JSON.parse(lines[0]!);
    expect(head).toMatchObject({ dsn: DSN, sent_at: '2026-11-27T00:00:00.000Z' });
    expect(JSON.parse(lines[1]!)).toEqual({ type: 'event' });
    const ev = JSON.parse(lines[2]!);
    expect(ev.event_id).toBe(head.event_id);
    expect(ev.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(ev).toMatchObject({ level: 'error', environment: 'production', release: 'cloud@1', transaction: '/runner/github-token', tags: { where: '/runner/github-token', route: 'runner' } });
    expect(ev.tags['Bad Tag']).toBeUndefined();
    expect(ev.exception.values[0]).toEqual({ type: 'TypeError', value: 'refresh refused for [redacted]' });
    expect(ev.extra.stack).toContain('TypeError');
  });

  test('sends with the Sentry auth header; nothing without a DSN; a dead Sentry never throws', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    });
    expect(await sendReport({ where: 'x', message: 'm' })).toBe(false);
    expect(calls).toHaveLength(0);
    vi.stubEnv('SENTRY_DSN', DSN);
    expect(await sendReport({ where: 'x', message: 'm' })).toBe(true);
    expect(calls[0]!.url).toBe('https://o42.ingest.sentry.io/api/4507/envelope/');
    expect((calls[0]!.init.headers as Record<string, string>)['X-Sentry-Auth']).toBe('Sentry sentry_version=7, sentry_key=abc123public, sentry_client=kiwimake-convex/1');
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(reportError(new Error('box create failed'), 'boxes.create')).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith('boxes.create:', 'box create failed');
  });

  test('queries and mutations report through the scheduled errors.report action', async () => {
    vi.stubEnv('SENTRY_DSN', DSN);
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response('{}');
    });
    const t = convexTest(schema, modules);
    await t.action(internal.errors.report, { where: 'billing.apply', message: 'no plan for a@example.com', level: 'warning' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('"level":"warning"');
    expect(bodies[0]).not.toContain('example.com');
  });

  test('a failing runner route is reported to Sentry and still answers 500', async () => {
    vi.stubEnv('SENTRY_DSN', DSN);
    const sent: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (String(url).includes('sentry.io')) {
        sent.push(String(init.body));
        return new Response('{}');
      }
      return realFetch(url, init);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert('users', { email: 'a@example.com', name: 'A', githubLogin: 'a', githubInstallationId: '1' }));
    const as = t.withIdentity({ subject: `${userId}|session1` });
    const appId = (await as.mutation(api.apps.create, { name: 'Prayer Alarm', prompt: 'Prayer times' })) as Id<'apps'>;
    const thread = (await t.run((ctx) => ctx.db.query('threads').withIndex('by_app', (q) => q.eq('appId', appId)).first()))!;
    const token = 'runner-token-for-tests-0123456789';
    await t.run((ctx) => ctx.db.patch(thread._id, { boxState: 'running', runnerTokenHash: '' }));
    await t.mutation(internal.boxes.setRunnerHash, { threadId: thread._id, hash: await sha256Hex(token) });
    // A build record with no number fails inside the mutation's argument check.
    const res = await t.fetch('/runner/build', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    expect(res.status).toBe(500);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"where":"/runner/build"');
    expect(sent[0]).not.toContain(token);
  });
});

describe('uptime and the deployment address', () => {
  test('/health answers ok after a database read', async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch('/health', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  test("the root page points at kiwimake.ai and carries Google's verification tag only when set and well formed", async () => {
    expect(rootPage(undefined)).not.toContain('google-site-verification');
    expect(rootPage('abcDEF_123-xyz456')).toContain('<meta name="google-site-verification" content="abcDEF_123-xyz456">');
    expect(rootPage('"><script>')).not.toContain('<script>');
    expect(rootPage(undefined)).toContain('https://kiwimake.ai/privacy');
    const t = convexTest(schema, modules);
    vi.stubEnv('GOOGLE_SITE_VERIFICATION', 'abcDEF_123-xyz456');
    const res = await t.fetch('/', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('content="abcDEF_123-xyz456"');
  });
});
