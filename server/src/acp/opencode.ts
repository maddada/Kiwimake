// OpenCode (https://opencode.ai, MIT) as the cloud's ACP agent: `opencode acp` over stdio, through
// the same ACP session as Claude (claude-session.ts), with this profile. What was learned from
// opencode 2.4.1 (agentInfo "OpenCode") against a stub provider (docs/CLOUD.md, "OpenCode"):
//   - initialize offers loadSession and session resume, http MCP, images, and one auth method
//     ("opencode-login", a terminal sign-in) that Kiwimake never uses: the key comes from the
//     environment variable the config names, which in the cloud is the Secrets proxy placeholder.
//   - session/new returns config options "model" (values "<provider>/<model>"), "effort"
//     (category thought_level: low, medium, high, default) and "mode" (build, plan). There are no
//     ACP session modes: full access is the config's permission "allow".
//   - MCP servers passed in session/new reach the model only through "Code Mode" (one `execute`
//     tool that runs JavaScript calling tools.<server>.<tool>), so Kiwimake's own tools would never
//     show by name. Servers set in opencode.json with `codemode: false` are offered as plain tools
//     named `<server>_<tool>`; the session rewrites those to `mcp__<server>__<tool>` so the chat
//     hides its own tools as it does for Claude.
//   - Its own `question` and `subagent` tools are denied: the person is on a phone (Kiwimake's
//     ask_choice asks them), and helpers are Kiwimake's start_worker, each metered at its level.
//     So are Code Mode's `execute`, its paid image and video generators, its automations, its web
//     search and its own `opencode_*` tools. A permission deny removes a tool; `tools: false` did not.
//   - It quietly asks a "small model" for titles: set to the same provider, so nothing else is called.
//   - It says it takes images for every model, but DeepSeek V4 Pro has no image input: the session
//     sends pictures as a line naming the file instead (opencodeTakesImages).
//   - Two providers in one config: the first, and a fallback. A provider that refuses a turn
//     (out of credit: errorName "provider.quota") fails session/prompt at once; one that is down is
//     retried for ever, shown only in session_info_update's _meta["opencode/retry"]. Either way the
//     session moves the turn to the fallback provider's model (claude-session.ts, fallbackModel).
//   - session/prompt's usage has inputTokens (not cached), outputTokens and cachedReadTokens.
// The config goes to opencode as a file named by OPENCODE_CONFIG: in the cloud the agent runs as
// another Unix user through sudo (which drops the environment), so the file sits in a folder both
// can read and its path goes on the command line through `env` (a path, never a secret).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { isJsonObject } from "./acp-client.ts";
import type { AcpAgentProfile, LaunchSpec } from "./claude-session.ts";
import type { ModelChoice, OpenCodeSettings } from "../cloud-settings.ts";

/** OpenCode's tool names for a server's tools: `<server>_<tool>`. */
export function claudeStyleOpencodeToolName(value: string, servers: readonly string[]): string {
  // The longest name first, so "app" never takes a call of a server named "app_store".
  for (const server of [...servers].sort((a, b) => b.length - a.length)) {
    const prefix = `${server}_`;
    if (value.startsWith(prefix) && value.length > prefix.length) return `mcp__${server}__${value.slice(prefix.length)}`;
  }
  return value;
}

export function normalizeOpencodeUpdate(update: unknown, servers: readonly string[]): unknown {
  if (!isJsonObject(update) || (update["sessionUpdate"] !== "tool_call" && update["sessionUpdate"] !== "tool_call_update")) return update;
  const out = { ...update };
  for (const key of ["name", "title"] as const) {
    if (typeof out[key] === "string") out[key] = claudeStyleOpencodeToolName(out[key], servers);
  }
  return out;
}

/** DeepSeek V4 Pro takes no pictures on any provider (OpenRouter lists text only; models.dev: attachment false). */
export const opencodeTakesImages = (model: string): boolean => !/deepseek-v4-pro/.test(model);

/** How many times OpenCode may retry a failing provider before the turn moves to the fallback. */
export const OPENCODE_RETRIES_BEFORE_FALLBACK = 3;

/**
 * A provider that is failing, from a session update: OpenCode retries a provider that is down
 * (5xx, timeouts) or busy (429) for ever, saying so only in a session_info_update's
 * `_meta["opencode/retry"]` ({ attempt, error: { type, status } }).
 */
export function opencodeProviderTrouble(update: unknown, retries = OPENCODE_RETRIES_BEFORE_FALLBACK): string | undefined {
  if (!isJsonObject(update) || update["sessionUpdate"] !== "session_info_update" || !isJsonObject(update["_meta"])) return undefined;
  const retry = update["_meta"]["opencode/retry"];
  if (!isJsonObject(retry) || typeof retry["attempt"] !== "number" || retry["attempt"] < retries) return undefined;
  const error = isJsonObject(retry["error"]) ? retry["error"] : {};
  return `${String(error["type"] ?? "provider error")}${typeof error["status"] === "number" ? ` ${error["status"]}` : ""}, ${retry["attempt"]} tries`;
}

/**
 * A provider that refused a turn at once: session/prompt fails with an error naming it, e.g.
 * "Insufficient credits ...: {"service":"session","errorName":"provider.quota"}" (also a refused
 * key, an unknown model or a provider that cannot be reached).
 */
export function isOpencodeProviderError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  // A key the provider refuses (401: wrong, revoked) comes back as ACP's "Authentication required".
  return /"errorName"\s*:\s*"provider\./.test(text) || /ProviderModelNotFound|ProviderInitError|ECONNREFUSED|ENOTFOUND|provider authentication required/i.test(text);
}

export function opencodeProfile(mcpServers: unknown[] = [], models: string[] = []): AcpAgentProfile {
  const servers = serverNames(mcpServers);
  return {
    label: "OpenCode",
    normalizeUpdate: (update) => normalizeOpencodeUpdate(update, servers),
    providerTrouble: (update) => opencodeProviderTrouble(update),
    isProviderError: isOpencodeProviderError,
    ...(models.some((m) => !opencodeTakesImages(m)) ? { images: false } : {}),
  };
}

function serverNames(mcpServers: unknown[]): string[] {
  return mcpServers.flatMap((s) => (isJsonObject(s) && typeof s["name"] === "string" ? [s["name"]] : []));
}

/** ACP's McpServer entries (http, with headers as name and value pairs) as opencode.json's `mcp`. */
export function opencodeMcp(mcpServers: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of mcpServers) {
    if (!isJsonObject(s) || typeof s["name"] !== "string" || typeof s["url"] !== "string") continue;
    const headers: Record<string, string> = {};
    for (const h of Array.isArray(s["headers"]) ? s["headers"] : []) {
      if (isJsonObject(h) && typeof h["name"] === "string" && typeof h["value"] === "string") headers[h["name"]] = h["value"];
    }
    // Plain tools, not Code Mode; no OAuth (our servers take a bearer token).
    out[s["name"]] = { type: "remote", url: s["url"], headers, codemode: false, oauth: false };
  }
  return out;
}

/** opencode.json for one session: the model, the provider (key by environment variable), full access, the MCP servers. */
export function opencodeConfig(settings: OpenCodeSettings, model: ModelChoice, mcpServers: unknown[], smallModel = model.model): Record<string, unknown> {
  // The first provider, and the fallback's two models, so a turn can move there in the same session.
  const routes = [{ provider: settings.provider, models: [model.model, smallModel] }];
  if (settings.fallback) routes.push({ provider: settings.fallback.provider, models: [settings.fallback.model, settings.fallback.simpleModel] });
  const provider: Record<string, unknown> = {};
  for (const { provider: p, models } of routes) {
    const ids = [...new Set(models)].map((m) => m.slice(p.id.length + 1));
    provider[p.id] = {
      ...(p.npm ? { npm: p.npm } : {}),
      ...(p.name ? { name: p.name } : {}),
      options: {
        ...(p.baseURL ? { baseURL: p.baseURL } : {}),
        apiKey: `{env:${p.apiKeyEnv}}`,
        // The OpenAI-compatible package leaves usage out of streams unless asked: every token is counted.
        ...(p.npm === "@ai-sdk/openai-compatible" ? { includeUsage: true } : {}),
      },
      models: Object.fromEntries(ids.map((id) => [id, {}])),
    };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    model: model.model,
    // Titles and summaries on the same provider (never another one that has no key here).
    small_model: smallModel,
    enabled_providers: routes.map((r) => r.provider.id),
    provider,
    mcp: opencodeMcp(mcpServers),
    // Unattended: the person is on a phone. Its own questions and subagents are Kiwimake's job.
    permission: {
      "*": "allow",
      question: "deny",
      subagent: "deny",
      task: "deny",
      execute: "deny",
      generate_image: "deny",
      generate_video: "deny",
      websearch: "deny",
      "automation_*": "deny",
      "opencode_*": "deny",
      opencode_worktree_remove: "deny",
    },
    autoupdate: false,
    share: "disabled",
  };
}

/**
 * Writes the session's opencode.json (readable by the agent's Unix user through the shared group,
 * not by others) and returns how to launch `opencode acp` with it.
 */
export function opencodeLaunch(settings: OpenCodeSettings, model: ModelChoice, mcpServers: unknown[], prefix: string[], fallbackDir: string, smallModel?: string): { launch: LaunchSpec; env: Record<string, string>; configPath: string } {
  const dir = settings.configDir ?? fallbackDir;
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, `opencode-${randomBytes(6).toString("hex")}.json`);
  writeFileSync(configPath, JSON.stringify(opencodeConfig(settings, model, mcpServers, smallModel), null, 2), { mode: 0o640 });
  chmodSync(configPath, 0o640);
  const env = { OPENCODE_CONFIG: configPath, OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_FREE_MODELS: "1" };
  if (prefix.length > 0) {
    const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    return { launch: { command: prefix[0]!, args: [...prefix.slice(1), "env", ...vars, settings.cli, "acp"] }, env: {}, configPath };
  }
  return { launch: { command: settings.cli, args: ["acp"] }, env, configPath };
}
