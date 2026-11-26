// The cloud's settings for the companion's work loop (docs/CLOUD.md section 3, "Models"): each app's
// chat is an orchestrator, and each helper runs at one of three levels. Only the cloud runner turns
// them on (ANYAPP_CLOUD=1); a PC runs as it always did.
//
// Which agent runs is the cloud's engine (ANYAPP_CLOUD_ENGINE, set by the runner from Convex's
// hello): "claude" (the default, the Claude Agent SDK's ACP adapter on Opus and Sonnet) or
// "opencode" (OpenCode's `opencode acp` on DeepSeek's API, or another provider OpenCode knows,
// server/src/acp/opencode.ts).

export type HelperLevel = "deep" | "focused" | "simple";
export const HELPER_LEVELS: readonly HelperLevel[] = ["deep", "focused", "simple"];

export type CloudEngine = "claude" | "opencode";
export const isCloudEngine = (value: unknown): value is CloudEngine => value === "claude" || value === "opencode";

export interface ModelChoice {
  model: string; // the engine's model id: claude-opus-5-5, or "<provider>/<model>" for OpenCode
  effort: string; // the ACP "effort" option: "high", "medium", ...
}

/**
 * The model provider OpenCode calls. The key is never in the config: `apiKeyEnv` names the
 * environment variable OpenCode reads it from, which in the cloud holds only Instabox's Secrets
 * proxy placeholder (the proxy adds the real key on the way out, docs/CLOUD.md section 2).
 */
export interface OpenCodeProvider {
  /** The provider id in model ids ("deepseek" in "deepseek/deepseek-v4-pro"). */
  id: string;
  /** The AI SDK package for a provider OpenCode does not know by itself (e.g. "@ai-sdk/openai-compatible"). */
  npm?: string;
  /** The API's base URL, when OpenCode's own catalog does not have it (or a stub in tests). */
  baseURL?: string;
  /** The environment variable with the API key (the proxy placeholder in the cloud). */
  apiKeyEnv: string;
  /** A display name, for OpenCode's own lists. */
  name?: string;
}

export interface OpenCodeSettings {
  provider: OpenCodeProvider;
  /** The opencode CLI: an absolute path, or a name the agent's PATH finds (the box: /opt/npm/bin). */
  cli: string;
  /** A folder both the runner and the agent can read, for each session's opencode.json. */
  configDir?: string;
}

export interface CloudSettings {
  engine: CloudEngine;
  orchestrator: ModelChoice;
  levels: Record<HelperLevel, ModelChoice>;
  /** Starts the agent as another Unix user, e.g. ["sudo", "-n", "-u", "agent", "-H", "/opt/kiwi/agent.sh"]. */
  agentPrefix: string[];
  /** engine "opencode" only. */
  opencode?: OpenCodeSettings;
}

export const DEFAULT_CLOUD: CloudSettings = {
  engine: "claude",
  orchestrator: { model: "claude-opus-5-5", effort: "high" },
  levels: {
    deep: { model: "claude-opus-5-5", effort: "high" },
    focused: { model: "claude-opus-5-5", effort: "medium" },
    simple: { model: "claude-sonnet-5-5", effort: "high" },
  },
  agentPrefix: [],
};

/**
 * The provider OpenCode calls by default: DeepSeek's own API (https://api-docs.deepseek.com), whose
 * terms allow "providing services to both internal and external end users". OpenCode Go is not the
 * default: OpenCode's terms allow its services "for your own internal use, and not on behalf of or
 * for the benefit of any third party" (docs/CLOUD.md, "OpenCode"), so it fits the owner's own tests
 * only (ANYAPP_OPENCODE_PROVIDER={"id":"opencode-go","apiKeyEnv":"OPENCODE_API_KEY"} and its models).
 */
export const DEEPSEEK_PROVIDER: OpenCodeProvider = { id: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" };
/** DeepSeek V4 Pro: the strongest, no image input. */
export const OPENCODE_DEFAULT_MODEL = "deepseek/deepseek-v4-pro";
/** deepseek-flash: DeepSeek V4.1 Flash (1017), quicker and cheaper, takes images. */
export const OPENCODE_DEFAULT_SIMPLE_MODEL = "deepseek/deepseek-flash";

/**
 * The orchestrator and the three levels on OpenCode: one strong model, a quicker one for simple
 * work. DeepSeek's effort values are none, low, high, max and default (no "medium"), so focused
 * work runs at the model's default.
 */
export function opencodeModels(model: string, simpleModel: string): Pick<CloudSettings, "orchestrator" | "levels"> {
  return {
    orchestrator: { model, effort: "high" },
    levels: {
      deep: { model, effort: "high" },
      focused: { model, effort: "default" },
      simple: { model: simpleModel, effort: "high" },
    },
  };
}

function parseProvider(text: string): OpenCodeProvider {
  const p = JSON.parse(text) as Partial<OpenCodeProvider>;
  if (!p || typeof p.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(p.id) || typeof p.apiKeyEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(p.apiKeyEnv)) {
    throw new Error('ANYAPP_OPENCODE_PROVIDER must be JSON like {"id":"opencode-go","apiKeyEnv":"OPENCODE_API_KEY"}');
  }
  return {
    id: p.id,
    apiKeyEnv: p.apiKeyEnv,
    ...(typeof p.npm === "string" ? { npm: p.npm } : {}),
    ...(typeof p.baseURL === "string" ? { baseURL: p.baseURL } : {}),
    ...(typeof p.name === "string" ? { name: p.name } : {}),
  };
}

export function cloudSettingsFromEnv(env: NodeJS.ProcessEnv): CloudSettings | undefined {
  if (env.ANYAPP_CLOUD !== "1") return undefined;
  let agentPrefix: string[] = [];
  if (env.ANYAPP_AGENT_PREFIX) {
    const parsed = JSON.parse(env.ANYAPP_AGENT_PREFIX) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === "string")) throw new Error("ANYAPP_AGENT_PREFIX must be a JSON array of strings");
    agentPrefix = parsed;
  }
  const engine = env.ANYAPP_CLOUD_ENGINE ?? "claude";
  if (!isCloudEngine(engine)) throw new Error(`ANYAPP_CLOUD_ENGINE must be "claude" or "opencode", not "${engine}"`);
  if (engine === "claude") return { ...DEFAULT_CLOUD, agentPrefix };
  const provider = env.ANYAPP_OPENCODE_PROVIDER ? parseProvider(env.ANYAPP_OPENCODE_PROVIDER) : DEEPSEEK_PROVIDER;
  const usual = provider.id === DEEPSEEK_PROVIDER.id;
  const model = env.ANYAPP_OPENCODE_MODEL || (usual ? OPENCODE_DEFAULT_MODEL : "");
  const simple = env.ANYAPP_OPENCODE_SIMPLE_MODEL || (usual && !env.ANYAPP_OPENCODE_MODEL ? OPENCODE_DEFAULT_SIMPLE_MODEL : model);
  for (const m of [model, simple]) {
    if (!m.startsWith(`${provider.id}/`) || m.length <= provider.id.length + 1) throw new Error(`The OpenCode model must be "${provider.id}/<model>", not "${m}"`);
  }
  return {
    engine,
    ...opencodeModels(model, simple),
    agentPrefix,
    opencode: {
      provider,
      cli: env.ANYAPP_OPENCODE_CLI || "opencode",
      ...(env.ANYAPP_OPENCODE_CONFIG_DIR ? { configDir: env.ANYAPP_OPENCODE_CONFIG_DIR } : {}),
    },
  };
}

/** The model and effort a helper at `level` gets (an unknown level: focused). */
export function levelChoice(settings: CloudSettings, level: string | undefined): ModelChoice {
  return settings.levels[(HELPER_LEVELS as readonly string[]).includes(level ?? "") ? (level as HelperLevel) : "focused"];
}
