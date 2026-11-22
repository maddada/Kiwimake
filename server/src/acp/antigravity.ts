// Antigravity (Google's `agy` CLI) as an ACP agent. How to run it follows t3code
// (https://github.com/pingdotgg/t3code, MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/provider/acp/AntigravityAcpSupport.ts and AntigravityProtocol.ts.
//   - `agy acp` over stdio; sign in with the "oauth-personal" auth method right after initialize.
//   - The playbook goes into the agent's system prompt with session/new's
//     `_meta.antigravity.systemPrompt.append`, when initialize says it takes one.
//   - The model and the thinking level are two session config options ("model", "thought_level").
//   - No client file access: advertising writes swaps the agent's diff edits for whole-file writes.
//   - Its own questions arrive as permission requests whose tool call id starts with "interaction_".
//   - A "refusal" stop reason is the plan's quota running out (QUOTA_EXHAUSTED).
// Unlike t3code, Kiwimake runs the PC's own `agy` with its own sign-in (as it does for Claude and
// Codex), and passes --dangerously-skip-permissions so the agent never waits on a person who is on
// a phone (ANYAPP_ASK_PERMISSIONS=1 keeps the questions, for development).
import { ANTIGRAVITY_EFFORT, ANTIGRAVITY_MODEL } from "../../../shared/engines.mts";
import { isJsonObject, type AcpPermissionRequest } from "./acp-client.ts";
import type { AcpAgentProfile, LaunchSpec, SessionModel } from "./claude-session.ts";

export function antigravityLaunchSpec(cli: string, askPermissions = false): LaunchSpec {
  return { command: cli, args: ["acp", ...(askPermissions ? [] : ["--dangerously-skip-permissions"])] };
}

export const ANTIGRAVITY_SESSION_MODEL: SessionModel = {
  model: ANTIGRAVITY_MODEL,
  effort: ANTIGRAVITY_EFFORT,
  configIds: { model: "model", effort: "thought_level" },
};

/** initialize's agentCapabilities._meta.antigravity.systemPrompt.append (t3code: antigravityAppendsSystemPrompt). */
export function antigravityAppendsSystemPrompt(initialize: unknown): boolean {
  const caps = isJsonObject(initialize) && isJsonObject(initialize["agentCapabilities"]) ? initialize["agentCapabilities"] : {};
  const meta = isJsonObject(caps["_meta"]) && isJsonObject(caps["_meta"]["antigravity"]) ? caps["_meta"]["antigravity"] : {};
  return isJsonObject(meta["systemPrompt"]) && meta["systemPrompt"]["append"] === true;
}

/**
 * Antigravity names an MCP tool `mcp_<server>_<tool>`; Kiwimake (and Claude) say
 * `mcp__<server>__<tool>`, which is what the chat looks for to hide its own tools (set_app_kind,
 * ask_choice, the page and worker tools). Only the servers this session was given are rewritten.
 */
export function claudeStyleToolName(value: string, servers: readonly string[]): string {
  // The longest name first, so "app" never takes a call of a server named "app_store".
  for (const server of [...servers].sort((a, b) => b.length - a.length)) {
    const prefix = `mcp_${server}_`;
    const at = value.indexOf(prefix);
    if (at >= 0 && value[at + prefix.length] !== undefined && !value.startsWith("mcp__", at)) {
      return `${value.slice(0, at)}mcp__${server}__${value.slice(at + prefix.length)}`;
    }
  }
  return value;
}

export function normalizeAntigravityUpdate(update: unknown, servers: readonly string[]): unknown {
  if (!isJsonObject(update) || (update["sessionUpdate"] !== "tool_call" && update["sessionUpdate"] !== "tool_call_update")) return update;
  const out = { ...update };
  for (const key of ["name", "title"] as const) {
    if (typeof out[key] === "string") out[key] = claudeStyleToolName(out[key], servers);
  }
  return out;
}

/**
 * Antigravity's own questions come as permission requests. Their answers are not approvals, so
 * none of them may be picked by itself: the chat shows the question and waits for the person.
 */
export function normalizeAntigravityPermission(request: AcpPermissionRequest): AcpPermissionRequest {
  const id = typeof request.toolCall["toolCallId"] === "string" ? request.toolCall["toolCallId"] : "";
  if (!id.startsWith("interaction_")) return request;
  return { ...request, options: request.options.map((o) => ({ ...o, kind: o.kind.startsWith("allow") ? "answer" : o.kind })) };
}

export function antigravityProfile(mcpServers: unknown[] = []): AcpAgentProfile {
  const servers = mcpServers.flatMap((s) => (isJsonObject(s) && typeof s["name"] === "string" ? [s["name"]] : []));
  return {
    label: "Antigravity",
    authMethod: "oauth-personal",
    systemPromptMeta: (initialize, instructions) =>
      antigravityAppendsSystemPrompt(initialize) ? { antigravity: { systemPrompt: { append: instructions } } } : undefined,
    normalizeUpdate: (update) => normalizeAntigravityUpdate(update, servers),
    normalizePermission: normalizeAntigravityPermission,
    quotaStop: {
      stopReason: "refusal",
      message: "Google says the quota for this period is used up (usage limit)",
      limit: (seenAt) => ({ engine: "antigravity", kind: "antigravity_quota", status: "rejected", seenAt }),
      ok: (seenAt) => ({ engine: "antigravity", kind: "antigravity_quota", status: "allowed", seenAt }),
    },
  };
}
