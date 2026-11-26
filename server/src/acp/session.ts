import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineName, findEngine, type Engine } from "../../../shared/engines.mts";
import type { Config } from "../config.ts";
import { ClaudeSession, claudeLaunchSpec, type ClaudeSessionOptions } from "./claude-session.ts";
import { CodexSession } from "./codex-session.ts";
import { CodexModels } from "./codex-model.ts";
import { ANTIGRAVITY_SESSION_MODEL, antigravityLaunchSpec, antigravityProfile } from "./antigravity.ts";
import { opencodeLaunch, opencodeProfile } from "./opencode.ts";
import { fallbackChoice } from "../cloud-settings.ts";

/** Claude, Antigravity and OpenCode run over ACP (ClaudeSession is the ACP session); Codex over its app-server. */
export type AgentSession = ClaudeSession | CodexSession;
/** The PC's engine. The cloud reports "claude" here whatever its agent is (App.engine, the plan limits). */
export const selectedEngine = (config: Pick<Config, "cloud" | "engine">): Engine => config.cloud ? "claude" : config.engine ?? "claude";
/** The agent that really runs: the PC's engine, or the cloud's (OpenCode only in the cloud, cloud-settings.ts). */
export type SessionEngine = Engine | "opencode";
export const sessionEngine = (config: Pick<Config, "cloud" | "engine">): SessionEngine => config.cloud?.engine === "opencode" ? "opencode" : selectedEngine(config);
/** The agent's name in messages: the cloud's OpenCode agent is never named after its provider. */
export const sessionEngineName = (engine: SessionEngine): string => engine === "opencode" ? "Kiwimake's AI" : engineName(engine);
export interface SessionRecord { sessionId?: string; sessionEngine?: SessionEngine; engineSessions?: Partial<Record<SessionEngine, string>> }
export function resumeFor(record: SessionRecord, engine: SessionEngine): string | undefined {
  return record.engineSessions?.[engine] ?? ((record.sessionEngine ?? "claude") === engine ? record.sessionId : undefined);
}
export function rememberSession(record: SessionRecord, engine: SessionEngine, id: string): void {
  record.engineSessions ??= {};
  if (record.sessionId) record.engineSessions[record.sessionEngine ?? "claude"] = record.sessionId;
  record.engineSessions[engine] = id;
  record.sessionId = id; record.sessionEngine = engine;
}
export function createSession(config: Config, options: Omit<ClaudeSessionOptions, "launch">): AgentSession {
  if (sessionEngine(config) === "opencode") {
    const cloud = config.cloud!;
    if (!cloud.opencode) throw new Error("The cloud's OpenCode settings are missing");
    const model = options.model ?? cloud.orchestrator;
    const fallbackModel = fallbackChoice(cloud, model, options.tag?.level === "simple");
    // MCP servers go in opencode.json (plain tools, not Code Mode), never in session/new as well.
    const mcp = options.mcpServers ?? [];
    const { launch, env } = opencodeLaunch(cloud.opencode, model, mcp, cloud.agentPrefix, join(config.stateDir || tmpdir(), "opencode"), cloud.levels.simple.model);
    return new ClaudeSession({
      ...options,
      env: { ...options.env, ...env },
      mcpServers: [],
      launch,
      // Pictures only when both providers' models take them (a turn may move to the fallback).
      profile: opencodeProfile(mcp, [model.model, ...(fallbackModel ? [fallbackModel.model] : [])]),
      model,
      ...(fallbackModel ? { fallbackModel: { ...fallbackModel, configIds: { model: "model", effort: "effort" } } } : {}),
      clientFs: false,
    });
  }
  if (selectedEngine(config) === "codex") {
    const cli = findEngine("codex");
    if (!cli) throw new Error("Codex is missing. Install it in Kiwimake Setup.");
    return new CodexSession({ ...options, models: new CodexModels(config.stateDir), launch: { command: cli, args: ["app-server", "--listen", "stdio://"] } });
  }
  if (selectedEngine(config) === "antigravity") {
    const cli = findEngine("antigravity");
    if (!cli) throw new Error("Antigravity is missing. Install it in Kiwimake Setup.");
    return new ClaudeSession({
      ...options,
      launch: antigravityLaunchSpec(cli, options.askPermissions),
      profile: antigravityProfile(options.mcpServers),
      model: ANTIGRAVITY_SESSION_MODEL,
      // t3code: advertising client writes swaps the agent's diff edits for whole-file writes.
      clientFs: false,
    });
  }
  // Cloud keeps its pinned engine. Desktop always passes the detected system Claude to ACP.
  const cli = config.cloud ? undefined : findEngine("claude");
  if (!config.cloud && !cli) throw new Error("Claude is missing. Install it in Kiwimake Setup.");
  return new ClaudeSession({ ...options, env: { ...options.env, ...(cli ? { CLAUDE_CODE_EXECUTABLE: cli } : {}) }, launch: claudeLaunchSpec(config.acpLaunch, config.cloud?.agentPrefix) });
}
