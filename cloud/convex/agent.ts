// The cloud's agent (docs/CLOUD.md section 3, "OpenCode, a second cloud engine"): which engine,
// provider and model run people's changes, as Convex environment variables on the deployment, so
// switching models is a settings change and never a release:
//   CLOUD_AGENT_ENGINE               "claude" (the default) or "opencode"
//   CLOUD_AGENT_PROVIDER             "openrouter" (the default), "therouter", "deepseek" or "opencode-go"
//   CLOUD_AGENT_MODEL                the model for the work, as the provider names it
//                                    ("deepseek/deepseek-v4-pro-0813" on OpenRouter); default: the
//                                    provider's newest DeepSeek (server/src/cloud-settings.ts)
//   CLOUD_AGENT_SIMPLE_MODEL         the model for simple work; default: the provider's Flash, or
//                                    CLOUD_AGENT_MODEL when that is set
//   CLOUD_AGENT_FALLBACK             the provider a turn moves to when the first one fails: by
//                                    default the other router (OpenRouter and TheRouter back each
//                                    other up); "none" for no fallback
//   CLOUD_AGENT_FALLBACK_MODEL, CLOUD_AGENT_FALLBACK_SIMPLE_MODEL   the same for the fallback
// The Own key plan always runs Claude: the person's key is an Anthropic key. OpenCode Go is only for
// the owner's own tests (OpenCode's terms: "for your own internal use"). The keys never reach Convex's
// hello or the box: the box gets Instabox proxy placeholders under these names (boxSecrets).
// This replaces config.ts's agentChoice (CLOUD_OPENCODE_*), which is no longer used.

export type AgentEngine = 'claude' | 'opencode';

/** Each provider's key name on the box (an Instabox proxy Secret) and the hosts that Secret may reach. */
export const AGENT_PROVIDERS: Readonly<Record<string, { keyEnv: string; hosts: string[] }>> = {
  openrouter: { keyEnv: 'OPENROUTER_API_KEY', hosts: ['openrouter.ai'] },
  therouter: { keyEnv: 'THEROUTER_API_KEY', hosts: ['api.therouter.ai'] },
  deepseek: { keyEnv: 'DEEPSEEK_API_KEY', hosts: ['api.deepseek.com'] },
  'opencode-go': { keyEnv: 'OPENCODE_API_KEY', hosts: ['opencode.ai'] },
};
export const DEFAULT_AGENT_PROVIDER = 'openrouter';
const OTHER_ROUTER: Readonly<Record<string, string>> = { openrouter: 'therouter', therouter: 'openrouter' };

export interface AgentChoice {
  engine: AgentEngine;
  /** The first provider's key name (ANTHROPIC_API_KEY for Claude). */
  keyEnv: string;
  /** Every key name the agent may use: the first provider's and the fallback's. */
  keyEnvs: string[];
  /** What the runner puts in its environment before the companion's work loop starts. */
  env: Record<string, string>;
}

/** Where the runner keeps each opencode session's config: a folder the agent can read too (the kiwi group). */
export const OPENCODE_CONFIG_DIR = '/data/apps/.opencode';

/** A model as the provider names it, or already as "<provider>/<model>": always the latter. */
export function providerModel(provider: string, model: string | undefined): string | undefined {
  const m = model?.trim();
  if (!m) return undefined;
  return m.startsWith(`${provider}/`) ? m : `${provider}/${m}`;
}

function provider(name: string, what: string): string {
  if (!AGENT_PROVIDERS[name]) throw new Error(`${what} must be one of ${Object.keys(AGENT_PROVIDERS).join(', ')}, not "${name}"`);
  return name;
}

export function agentChoice(aiMode: string | undefined, env: Record<string, string | undefined> = process.env): AgentChoice {
  const engine: AgentEngine = env.CLOUD_AGENT_ENGINE === 'opencode' && aiMode !== 'ownAnthropic' ? 'opencode' : 'claude';
  if (engine === 'claude') return { engine, keyEnv: 'ANTHROPIC_API_KEY', keyEnvs: ['ANTHROPIC_API_KEY'], env: { ANYAPP_CLOUD_ENGINE: 'claude' } };
  const first = provider(env.CLOUD_AGENT_PROVIDER?.trim() || DEFAULT_AGENT_PROVIDER, 'CLOUD_AGENT_PROVIDER');
  const fallbackName = env.CLOUD_AGENT_FALLBACK?.trim() || OTHER_ROUTER[first] || 'none';
  const fallback = fallbackName === 'none' ? undefined : provider(fallbackName, 'CLOUD_AGENT_FALLBACK');
  if (fallback === first) throw new Error('CLOUD_AGENT_FALLBACK must be another provider than CLOUD_AGENT_PROVIDER');
  const out: Record<string, string> = {
    ANYAPP_CLOUD_ENGINE: 'opencode',
    ANYAPP_OPENCODE_PROVIDER: first,
    ANYAPP_OPENCODE_FALLBACK_PROVIDER: fallback ?? 'none',
    ANYAPP_OPENCODE_CONFIG_DIR: OPENCODE_CONFIG_DIR,
  };
  const set = (name: string, value: string | undefined) => {
    if (value) out[name] = value;
  };
  set('ANYAPP_OPENCODE_MODEL', providerModel(first, env.CLOUD_AGENT_MODEL));
  set('ANYAPP_OPENCODE_SIMPLE_MODEL', providerModel(first, env.CLOUD_AGENT_SIMPLE_MODEL));
  if (fallback) {
    set('ANYAPP_OPENCODE_FALLBACK_MODEL', providerModel(fallback, env.CLOUD_AGENT_FALLBACK_MODEL));
    set('ANYAPP_OPENCODE_FALLBACK_SIMPLE_MODEL', providerModel(fallback, env.CLOUD_AGENT_FALLBACK_SIMPLE_MODEL));
  }
  const keyEnvs = [AGENT_PROVIDERS[first]!.keyEnv, ...(fallback ? [AGENT_PROVIDERS[fallback]!.keyEnv] : [])];
  return { engine, keyEnv: keyEnvs[0]!, keyEnvs, env: out };
}

/** The box's proxy Secrets: BOX_PROXY_SECRETS when set (comma separated), else every key the agent may use. */
export function boxSecrets(choice: AgentChoice, env: Record<string, string | undefined> = process.env): string[] {
  return (env.BOX_PROXY_SECRETS ?? choice.keyEnvs.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
}
