// The cloud's agent setting (convex/agent.ts) and what its models cost (convex/agentPrices.ts).
import { describe, expect, it } from 'vitest';
import { agentChoice, AGENT_PROVIDERS, boxSecrets, providerModel } from '../convex/agent';
import { AGENT_MODEL_PRICES } from '../convex/agentPrices';
import { priceTokens } from '../convex/billing';
import { MODEL_PRICES } from '../convex/config';
import { cloudSettingsFromEnv } from '../../server/src/cloud-settings';

const tokens = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 1_000_000 };

describe('the agent setting', () => {
  it('is Claude unless the deployment asks for opencode, and the Own key plan always runs Claude', () => {
    expect(agentChoice('credit', {})).toEqual({ engine: 'claude', keyEnv: 'ANTHROPIC_API_KEY', keyEnvs: ['ANTHROPIC_API_KEY'], env: { ANYAPP_CLOUD_ENGINE: 'claude' } });
    expect(agentChoice('ownAnthropic', { CLOUD_AGENT_ENGINE: 'opencode' }).engine).toBe('claude');
    expect(boxSecrets(agentChoice('credit', {}), {})).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('runs opencode on OpenRouter by default, with TheRouter as the fallback, and both keys as proxy Secrets', () => {
    const c = agentChoice('credit', { CLOUD_AGENT_ENGINE: 'opencode' });
    expect(c.engine).toBe('opencode');
    expect(c.keyEnvs).toEqual(['OPENROUTER_API_KEY', 'THEROUTER_API_KEY']);
    expect(c.env).toEqual({ ANYAPP_CLOUD_ENGINE: 'opencode', ANYAPP_OPENCODE_PROVIDER: 'openrouter', ANYAPP_OPENCODE_FALLBACK_PROVIDER: 'therouter', ANYAPP_OPENCODE_CONFIG_DIR: '/data/apps/.opencode' });
    expect(boxSecrets(c, {})).toEqual(['OPENROUTER_API_KEY', 'THEROUTER_API_KEY']);
    expect(AGENT_PROVIDERS.openrouter!.hosts).toEqual(['openrouter.ai']);
    expect(AGENT_PROVIDERS.therouter!.hosts).toEqual(['api.therouter.ai']);
    // The box's companion reads exactly this (server/src/cloud-settings.ts).
    const s = cloudSettingsFromEnv({ ANYAPP_CLOUD: '1', ...c.env })!;
    expect([s.orchestrator.model, s.levels.simple.model]).toEqual(['openrouter/deepseek/deepseek-v4-pro-0813', 'openrouter/deepseek/deepseek-v4.1-flash-1017']);
    expect([s.opencode!.fallback!.model, s.opencode!.fallback!.simpleModel]).toEqual(['therouter/deepseek/deepseek-v4-pro', 'therouter/deepseek/deepseek-v4-flash']);
  });

  it('switches provider and model with settings only, models as the provider names them', () => {
    const c = agentChoice('credit', { CLOUD_AGENT_ENGINE: 'opencode', CLOUD_AGENT_PROVIDER: 'therouter', CLOUD_AGENT_MODEL: 'moonshotai/kimi-k3', CLOUD_AGENT_FALLBACK_MODEL: 'openrouter/moonshotai/kimi-k3' });
    expect(c.keyEnvs).toEqual(['THEROUTER_API_KEY', 'OPENROUTER_API_KEY']);
    expect(c.env.ANYAPP_OPENCODE_MODEL).toBe('therouter/moonshotai/kimi-k3');
    expect(c.env.ANYAPP_OPENCODE_FALLBACK_MODEL).toBe('openrouter/moonshotai/kimi-k3');
    const s = cloudSettingsFromEnv({ ANYAPP_CLOUD: '1', ...c.env })!;
    expect([s.orchestrator.model, s.levels.simple.model, s.opencode!.fallback!.model]).toEqual(['therouter/moonshotai/kimi-k3', 'therouter/moonshotai/kimi-k3', 'openrouter/moonshotai/kimi-k3']);
    const none = agentChoice('credit', { CLOUD_AGENT_ENGINE: 'opencode', CLOUD_AGENT_FALLBACK: 'none' });
    expect(none.keyEnvs).toEqual(['OPENROUTER_API_KEY']);
    expect(cloudSettingsFromEnv({ ANYAPP_CLOUD: '1', ...none.env })!.opencode!.fallback).toBeUndefined();
    expect(providerModel('openrouter', ' deepseek/x ')).toBe('openrouter/deepseek/x');
    expect(() => agentChoice('credit', { CLOUD_AGENT_ENGINE: 'opencode', CLOUD_AGENT_PROVIDER: 'acme' })).toThrow(/CLOUD_AGENT_PROVIDER must be one of/);
    expect(() => agentChoice('credit', { CLOUD_AGENT_ENGINE: 'opencode', CLOUD_AGENT_FALLBACK: 'openrouter' })).toThrow(/another provider/);
  });
});

describe('what the router models cost', () => {
  it('prices every default model, never under the dearest host plus the fee, and never as Opus by mistake', () => {
    for (const provider of ['openrouter', 'therouter']) {
      const s = cloudSettingsFromEnv({ ANYAPP_CLOUD: '1', ...agentChoice('credit', { CLOUD_AGENT_ENGINE: 'opencode', CLOUD_AGENT_PROVIDER: provider }).env })!;
      for (const m of [s.orchestrator.model, s.levels.simple.model, s.opencode!.fallback!.model, s.opencode!.fallback!.simpleModel]) expect(AGENT_MODEL_PRICES[m], m).toBeDefined();
    }
    // OpenRouter V4 Pro 0813: dearest host $1.98 / $5.94, cache read $0.284, plus 5.5%.
    expect(AGENT_MODEL_PRICES['openrouter/deepseek/deepseek-v4-pro-0813']).toEqual([2_088_900, 6_266_700, 2_088_900, 299_620]);
    expect(priceTokens('openrouter/deepseek/deepseek-v4-pro-0813', tokens)).toBe(2_088_900 + 6_266_700 + 299_620);
    expect(priceTokens('therouter/deepseek/deepseek-v4-flash', tokens)).toBe(162_000 + 648_000 + 162_000);
    // An unknown model still costs Opus (never under), and Claude's prices are unchanged.
    expect(priceTokens('openrouter/acme/unknown', tokens)).toBe(priceTokens('claude-opus-5-5', tokens));
    expect(priceTokens('claude-sonnet-5-5', tokens)).toBe(MODEL_PRICES['claude-sonnet-5-5']![0] + MODEL_PRICES['claude-sonnet-5-5']![1] + MODEL_PRICES['claude-sonnet-5-5']![3]);
  });
});
