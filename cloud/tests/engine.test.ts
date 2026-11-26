// The cloud's engine (docs/CLOUD.md section 3, "OpenCode, a second cloud engine"): Claude by default, opencode with
// DeepSeek when the deployment says so; the Own key plan always Claude; DeepSeek priced at its
// peak list price; the box's proxy Secret and the runner's environment follow the engine.
import { convexTest } from 'convex-test';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import schema from '../convex/schema';
import { priceTokens } from '../convex/billing';
import { agentChoice, boxSecrets } from '../convex/config';
import { agentChoice as newAgentChoice } from '../convex/agent';

const modules = import.meta.glob('../convex/**/*.*s');

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.useFakeTimers();
  vi.stubEnv('RUNNER_POLL_MS', '0');
});

const OPENCODE_ENV = {
  ANYAPP_CLOUD_ENGINE: 'opencode',
  ANYAPP_OPENCODE_PROVIDER: '{"id":"deepseek","apiKeyEnv":"DEEPSEEK_API_KEY"}',
  ANYAPP_OPENCODE_MODEL: 'deepseek/deepseek-v4-pro',
  ANYAPP_OPENCODE_SIMPLE_MODEL: 'deepseek/deepseek-flash',
  ANYAPP_OPENCODE_CONFIG_DIR: '/data/apps/.opencode',
};

describe('the engine choice', () => {
  test('Claude by default, with the Anthropic key as the box Secret', () => {
    const c = agentChoice('credit', {});
    expect(c).toEqual({ engine: 'claude', keyEnv: 'ANTHROPIC_API_KEY', env: { ANYAPP_CLOUD_ENGINE: 'claude' } });
    expect(boxSecrets(c, {})).toEqual(['ANTHROPIC_API_KEY']);
  });

  test('opencode on DeepSeek when the deployment says so; the box gets DEEPSEEK_API_KEY only', () => {
    const c = agentChoice('credit', { CLOUD_AGENT_ENGINE: 'opencode' });
    expect(c).toEqual({ engine: 'opencode', keyEnv: 'DEEPSEEK_API_KEY', env: OPENCODE_ENV });
    expect(boxSecrets(c, {})).toEqual(['DEEPSEEK_API_KEY']);
    // An explicit list still wins (two engines' keys on one deployment while switching).
    expect(boxSecrets(c, { BOX_PROXY_SECRETS: 'ANTHROPIC_API_KEY, DEEPSEEK_API_KEY' })).toEqual(['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY']);
  });

  test('the Own key plan always runs Claude: the key is an Anthropic key', () => {
    expect(agentChoice('ownAnthropic', { CLOUD_AGENT_ENGINE: 'opencode' }).engine).toBe('claude');
  });

  test('another provider needs its own models; a model of another provider is refused', () => {
    const go = agentChoice('credit', {
      CLOUD_AGENT_ENGINE: 'opencode',
      CLOUD_OPENCODE_PROVIDER: '{"id":"opencode-go","apiKeyEnv":"OPENCODE_API_KEY"}',
      CLOUD_OPENCODE_MODEL: 'opencode-go/deepseek-v4-pro',
      CLOUD_OPENCODE_SIMPLE_MODEL: 'opencode-go/deepseek-v4.1-flash',
    });
    expect(go.keyEnv).toBe('OPENCODE_API_KEY');
    expect(go.env.ANYAPP_OPENCODE_SIMPLE_MODEL).toBe('opencode-go/deepseek-v4.1-flash');
    expect(() => agentChoice('credit', { CLOUD_AGENT_ENGINE: 'opencode', CLOUD_OPENCODE_PROVIDER: '{"id":"opencode-go","apiKeyEnv":"OPENCODE_API_KEY"}' })).toThrow(/opencode-go\/<model>/);
    expect(() => agentChoice('credit', { CLOUD_AGENT_ENGINE: 'opencode', CLOUD_OPENCODE_PROVIDER: '{"id":"Bad id","apiKeyEnv":"x"}' })).toThrow(/CLOUD_OPENCODE_PROVIDER/);
    expect(() => agentChoice('credit', { CLOUD_AGENT_ENGINE: 'opencode', CLOUD_OPENCODE_MODEL: 'openai/gpt-x' })).toThrow(/deepseek\/<model>/);
  });
});

describe('DeepSeek prices', () => {
  const TURN = { inputTokens: 100_000, outputTokens: 10_000, cacheWriteTokens: 0, cacheReadTokens: 1_000_000 };
  test('priced at the peak list price, never as Opus', () => {
    // V4 Pro peak: $1.32 in, $3.96 out, $0.044 cache hit per million.
    expect(priceTokens('deepseek/deepseek-v4-pro', TURN)).toBe(132_000 + 39_600 + 44_000);
    // Flash peak: $0.30 in, $1.20 out, $0.006 cache hit.
    expect(priceTokens('deepseek/deepseek-flash', TURN)).toBe(30_000 + 12_000 + 6_000);
    expect(priceTokens('opencode-go/deepseek-v4-pro', TURN)).toBe(priceTokens('deepseek/deepseek-v4-pro', TURN));
    // An unknown model still prices as Opus.
    expect(priceTokens('deepseek/deepseek-v9', TURN)).toBe(priceTokens('claude-opus-5-5', TURN));
  });
});

describe("the runner's hello", () => {
  async function setup() {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert('users', { email: 'a@example.com', githubLogin: 'a', githubInstallationId: '1' }));
    const as = t.withIdentity({ subject: `${userId}|s` });
    const appId = (await as.mutation(api.apps.create, { name: 'Tip Split', prompt: 'tips' })) as Id<'apps'>;
    const thread = (await t.run((ctx) => ctx.db.query('threads').withIndex('by_app', (q) => q.eq('appId', appId)).first()))!;
    return { t, userId, thread };
  }

  test('says which engine and environment the box runs', async () => {
    const { t, thread } = await setup();
    expect((await t.mutation(internal.runner.hello, { threadId: thread._id })).agent).toEqual({ engine: 'claude', keyEnv: 'ANTHROPIC_API_KEY', keyEnvs: ['ANTHROPIC_API_KEY'], env: { ANYAPP_CLOUD_ENGINE: 'claude' } });
    vi.stubEnv('CLOUD_AGENT_ENGINE', 'opencode');
    // The hello now follows convex/agent.ts (OpenRouter first, TheRouter as the fallback; tests/agent.test.ts).
    expect((await t.mutation(internal.runner.hello, { threadId: thread._id })).agent).toEqual(newAgentChoice('credit', { CLOUD_AGENT_ENGINE: 'opencode' }));
  });

  test('the Own key plan gets Claude even on an opencode deployment', async () => {
    const { t, userId, thread } = await setup();
    vi.stubEnv('CLOUD_AGENT_ENGINE', 'opencode');
    await t.run((ctx) => ctx.db.patch(userId, { aiMode: 'ownAnthropic' }));
    expect((await t.mutation(internal.runner.hello, { threadId: thread._id })).agent.engine).toBe('claude');
  });
});
