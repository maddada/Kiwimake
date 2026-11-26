// node --test cloud/runner/runner.test.mjs: the runner's engine choice and the agent-env lines.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentOf, placeholderLines } from './runner.mjs';

test('an older Convex (no agent in hello) means Claude', () => {
  assert.deepEqual(agentOf({}), { engine: 'claude', keyEnv: 'ANTHROPIC_API_KEY', env: { ANYAPP_CLOUD_ENGINE: 'claude' } });
});

test('opencode: only ANYAPP_CLOUD_ENGINE and ANYAPP_OPENCODE_* reach the environment', () => {
  const a = agentOf({ agent: { engine: 'opencode', keyEnv: 'DEEPSEEK_API_KEY', env: { ANYAPP_CLOUD_ENGINE: 'opencode', ANYAPP_OPENCODE_MODEL: 'deepseek/deepseek-v4-pro', PATH: '/evil', ANYAPP_AGENT_PREFIX: '[]' } } });
  assert.deepEqual(a, { engine: 'opencode', keyEnv: 'DEEPSEEK_API_KEY', env: { ANYAPP_CLOUD_ENGINE: 'opencode', ANYAPP_OPENCODE_MODEL: 'deepseek/deepseek-v4-pro' } });
});

test('agent-env carries proxy placeholders only, never a real key', () => {
  const env = { ANTHROPIC_API_KEY: 'ibsec_abc123', DEEPSEEK_API_KEY: 'ibsec_def456', OPENCODE_API_KEY: 'sk-real-key' };
  assert.equal(placeholderLines(env, ['DEEPSEEK_API_KEY']), 'export ANTHROPIC_API_KEY=ibsec_abc123\nexport DEEPSEEK_API_KEY=ibsec_def456\n');
  assert.equal(placeholderLines(env, ['OPENCODE_API_KEY']), 'export ANTHROPIC_API_KEY=ibsec_abc123\n');
  assert.equal(placeholderLines({ DEEPSEEK_API_KEY: 'ibsec_x; rm -rf /' }, ['DEEPSEEK_API_KEY']), '');
  assert.equal(placeholderLines(env, ['bad name']), 'export ANTHROPIC_API_KEY=ibsec_abc123\n');
});
