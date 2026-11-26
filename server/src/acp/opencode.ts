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
//     sends pictures as a line naming the file instead (OPENCODE_NO_IMAGES).
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

/** Models OpenCode offers that take no pictures (models.dev: attachment false). */
export const OPENCODE_NO_IMAGES = new Set(["deepseek/deepseek-v4-pro", "opencode-go/deepseek-v4-pro"]);

export function opencodeProfile(mcpServers: unknown[] = [], model?: string): AcpAgentProfile {
  const servers = serverNames(mcpServers);
  return {
    label: "OpenCode",
    normalizeUpdate: (update) => normalizeOpencodeUpdate(update, servers),
    ...(model && OPENCODE_NO_IMAGES.has(model) ? { images: false } : {}),
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
  const p = settings.provider;
  const ids = [...new Set([model.model, smallModel])].map((m) => m.slice(p.id.length + 1));
  return {
    $schema: "https://opencode.ai/config.json",
    model: model.model,
    // Titles and summaries on the same provider (never another one that has no key here).
    small_model: smallModel,
    enabled_providers: [p.id],
    provider: {
      [p.id]: {
        ...(p.npm ? { npm: p.npm } : {}),
        ...(p.name ? { name: p.name } : {}),
        options: { ...(p.baseURL ? { baseURL: p.baseURL } : {}), apiKey: `{env:${p.apiKeyEnv}}` },
        models: Object.fromEntries(ids.map((id) => [id, {}])),
      },
    },
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
