// The cloud's settings for the companion's work loop (docs/CLOUD.md section 3, "Models"): each app's
// chat is an orchestrator, and each helper runs at one of three levels. Only the cloud runner turns
// them on (ANYAPP_CLOUD=1); a PC runs as it always did.
//
// Which agent runs is the cloud's engine (ANYAPP_CLOUD_ENGINE, set by the runner from Convex's
// hello): "claude" (the default, the Claude Agent SDK's ACP adapter on Opus and Sonnet) or
// "opencode" (OpenCode's `opencode acp` on OpenRouter, falling back to TheRouter, or another
// provider OpenCode knows, server/src/acp/opencode.ts).

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
  /** The provider id in model ids ("openrouter" in "openrouter/deepseek/deepseek-v4-pro-0813"). */
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

/** A provider and the two models used on it (the work, and simple work). */
export interface OpenCodeRoute {
  provider: OpenCodeProvider;
  /** "<provider>/<model>" for the orchestrator, deep and focused work. */
  model: string;
  /** "<provider>/<model>" for simple work (and OpenCode's own titles). */
  simpleModel: string;
}

export interface OpenCodeSettings {
  provider: OpenCodeProvider;
  /**
   * The second provider: when the first one fails (out of credit, down, refusing the key) a turn
   * moves to it, in the same session (acp/opencode.ts). Absent: no fallback.
   */
  fallback?: OpenCodeRoute;
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
 * The providers OpenCode may call, by id. Each is chosen for its terms (docs/CLOUD.md, "OpenCode"):
 *   - openrouter (the default) and therouter (its fallback): routers whose terms let a product
 *     serve its own customers through them; one key reaches many models, so a model is a setting.
 *   - deepseek: DeepSeek's own API ("providing services to both internal and external end users").
 *   - opencode-go: OpenCode's terms allow it only "for your own internal use", so the owner's own
 *     tests only, never people's changes.
 * OpenRouter is in OpenCode's own catalog; TheRouter speaks the OpenAI API, through the AI SDK's
 * openai-compatible package (usage included in streams, so every token is counted).
 */
export const PROVIDERS: Readonly<Record<string, OpenCodeProvider>> = {
  openrouter: { id: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", name: "OpenRouter" },
  therouter: { id: "therouter", npm: "@ai-sdk/openai-compatible", baseURL: "https://api.therouter.ai/v1", apiKeyEnv: "THEROUTER_API_KEY", name: "TheRouter" },
  deepseek: { id: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY", name: "DeepSeek" },
  "opencode-go": { id: "opencode-go", apiKeyEnv: "OPENCODE_API_KEY", name: "OpenCode Go" },
};

/** Each provider's newest DeepSeek: the strongest for the work, the quicker Flash for simple work. */
export const PROVIDER_MODELS: Readonly<Record<string, { model: string; simpleModel: string }>> = {
  // https://openrouter.ai/api/v1/models (26 Nov 2026): V4 Pro 0813 (no images), V4.1 Flash 1017.
  openrouter: { model: "openrouter/deepseek/deepseek-v4-pro-0813", simpleModel: "openrouter/deepseek/deepseek-v4.1-flash-1017" },
  // https://therouter.ai/models/ (26 Nov 2026): its Flash id serves V4.1 Flash (TheRouter's blog, 10 Sep 2026).
  therouter: { model: "therouter/deepseek/deepseek-v4-pro", simpleModel: "therouter/deepseek/deepseek-v4-flash" },
  deepseek: { model: "deepseek/deepseek-v4-pro", simpleModel: "deepseek/deepseek-flash" },
  "opencode-go": { model: "opencode-go/deepseek-v4-pro", simpleModel: "opencode-go/deepseek-v4.1-flash" },
};

/** With engine "opencode" and no provider named: OpenRouter, falling back to TheRouter. */
export const DEFAULT_PROVIDER = "openrouter";
export const DEFAULT_FALLBACK: Readonly<Record<string, string>> = { openrouter: "therouter", therouter: "openrouter" };
export const OPENCODE_DEFAULT_MODEL = PROVIDER_MODELS.openrouter!.model;
export const OPENCODE_DEFAULT_SIMPLE_MODEL = PROVIDER_MODELS.openrouter!.simpleModel;

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

/** A provider by id ("openrouter"), or as JSON for one Kiwimake does not know (a stub in tests). */
function parseProvider(text: string, name: string): OpenCodeProvider {
  if (!text.trim().startsWith("{")) {
    const known = PROVIDERS[text.trim()];
    if (!known) throw new Error(`${name} must be one of ${Object.keys(PROVIDERS).join(", ")}, or JSON like {"id":"openrouter","apiKeyEnv":"OPENROUTER_API_KEY"}`);
    return known;
  }
  const p = JSON.parse(text) as Partial<OpenCodeProvider>;
  if (!p || typeof p.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(p.id) || typeof p.apiKeyEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(p.apiKeyEnv)) {
    throw new Error(`${name} must be a provider id, or JSON like {"id":"openrouter","apiKeyEnv":"OPENROUTER_API_KEY"}`);
  }
  // A known id keeps what Kiwimake knows about it (its package, address and name) unless the JSON says otherwise.
  const base = PROVIDERS[p.id];
  return {
    id: p.id,
    apiKeyEnv: p.apiKeyEnv,
    ...(typeof p.npm === "string" ? { npm: p.npm } : base?.npm ? { npm: base.npm } : {}),
    ...(typeof p.baseURL === "string" ? { baseURL: p.baseURL } : base?.baseURL ? { baseURL: base.baseURL } : {}),
    ...(typeof p.name === "string" ? { name: p.name } : base?.name ? { name: base.name } : {}),
  };
}

/** A provider and its two models from the environment (models default to the provider's newest DeepSeek). */
function routeFrom(provider: OpenCodeProvider, model: string | undefined, simple: string | undefined): OpenCodeRoute {
  const usual = PROVIDER_MODELS[provider.id];
  const m = model || usual?.model || "";
  const sm = simple || (!model ? usual?.simpleModel : undefined) || m;
  for (const x of [m, sm]) {
    if (!x.startsWith(`${provider.id}/`) || x.length <= provider.id.length + 1) throw new Error(`The OpenCode model must be "${provider.id}/<model>", not "${x}"`);
  }
  return { provider, model: m, simpleModel: sm };
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
  const provider = parseProvider(env.ANYAPP_OPENCODE_PROVIDER || DEFAULT_PROVIDER, "ANYAPP_OPENCODE_PROVIDER");
  const main = routeFrom(provider, env.ANYAPP_OPENCODE_MODEL, env.ANYAPP_OPENCODE_SIMPLE_MODEL);
  // The fallback: named, "none", or the other router by default.
  const fallbackName = env.ANYAPP_OPENCODE_FALLBACK_PROVIDER ?? DEFAULT_FALLBACK[provider.id] ?? "none";
  let fallback: OpenCodeRoute | undefined;
  if (fallbackName && fallbackName !== "none") {
    const fp = parseProvider(fallbackName, "ANYAPP_OPENCODE_FALLBACK_PROVIDER");
    if (fp.id === provider.id) throw new Error("The fallback provider must be another provider");
    fallback = routeFrom(fp, env.ANYAPP_OPENCODE_FALLBACK_MODEL, env.ANYAPP_OPENCODE_FALLBACK_SIMPLE_MODEL);
  }
  return {
    engine,
    ...opencodeModels(main.model, main.simpleModel),
    agentPrefix,
    opencode: {
      provider,
      ...(fallback ? { fallback } : {}),
      cli: env.ANYAPP_OPENCODE_CLI || "opencode",
      ...(env.ANYAPP_OPENCODE_CONFIG_DIR ? { configDir: env.ANYAPP_OPENCODE_CONFIG_DIR } : {}),
    },
  };
}

/** The same work on the fallback provider: its simple model for simple work, else its main model. */
export function fallbackChoice(settings: CloudSettings, choice: ModelChoice, simple: boolean): ModelChoice | undefined {
  const fb = settings.opencode?.fallback;
  if (!fb) return undefined;
  return { model: simple ? fb.simpleModel : fb.model, effort: choice.effort };
}

/** The model and effort a helper at `level` gets (an unknown level: focused). */
export function levelChoice(settings: CloudSettings, level: string | undefined): ModelChoice {
  return settings.levels[(HELPER_LEVELS as readonly string[]).includes(level ?? "") ? (level as HelperLevel) : "focused"];
}
