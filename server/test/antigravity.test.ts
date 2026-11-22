import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { ClaudeSession, pickAllowOption, type ClaudeSessionOptions, type PermissionAsk } from "../src/acp/claude-session.ts";
import { ANTIGRAVITY_SESSION_MODEL, antigravityLaunchSpec, antigravityProfile, claudeStyleToolName, normalizeAntigravityPermission } from "../src/acp/antigravity.ts";
import { ChatTranslator } from "../src/acp/translate.ts";
import { isSetAppKindCall } from "../src/history.ts";
import { agentFailure } from "../src/apps.ts";
import { ENGINES, engineCandidates, engineInstaller, engineName, engineUpdate, isEngine } from "../../shared/engines.mts";
import type { PlanLimit } from "../../shared/protocol.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/agy-acp.mjs", import.meta.url));
const MCP = [{ type: "http", name: "app", url: "http://127.0.0.1:1/mcp/app/x", headers: [] }];

function session(extra: Partial<ClaudeSessionOptions> = {}) {
  const updates: any[] = []; const usage: any[] = []; const limits: PlanLimit[] = []; const asks: PermissionAsk[] = []; const logs: string[] = [];
  const s = new ClaudeSession({
    cwd: process.cwd(), instructions: "PLAYBOOK", mcpServers: MCP,
    launch: { command: process.execPath, args: [FIXTURE, ...antigravityLaunchSpec("agy").args] },
    profile: antigravityProfile(MCP), model: ANTIGRAVITY_SESSION_MODEL, clientFs: false,
    onUpdate: (u) => updates.push(u), onUsage: (u) => usage.push(u), onPlanLimit: (l) => limits.push(l),
    onPermission: (a) => asks.push(a), onExit: () => {}, log: (m) => logs.push(m), ...extra,
  });
  const said = () => updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("");
  const report = async () => { updates.length = 0; await s.prompt("report"); return JSON.parse(said()); };
  return { s, updates, usage, limits, asks, logs, said, report };
}

describe("Antigravity as an engine", () => {
  it("is a third engine with its own CLI, installer and updater", () => {
    expect(ENGINES).toEqual(["claude", "codex", "antigravity"]);
    expect(isEngine("antigravity")).toBe(true);
    expect(engineName("antigravity")).toBe("Antigravity");
    expect(engineCandidates("antigravity", { PATH: "/x/bin", HOME: "/home/u" }, "linux")).toContain("/home/u/.local/bin/agy");
    expect(engineCandidates("antigravity", { PATH: "C:\\x", USERPROFILE: "C:\\Users\\u", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32").some((p) => /agy[\\/]bin[\\/]agy\.exe$/.test(p))).toBe(true);
    expect(engineCandidates("antigravity", { ANTIGRAVITY_EXECUTABLE: "/opt/agy" })).toEqual(["/opt/agy"]);
    expect(engineInstaller("antigravity", "linux").url).toBe("https://antigravity.google/cli/install.sh");
    expect(engineInstaller("antigravity", "win32").url).toBe("https://antigravity.google/cli/install.ps1");
    expect(engineUpdate("antigravity", "/home/u/.local/bin/agy", (p) => p)).toEqual({ command: "/home/u/.local/bin/agy", args: ["update"] });
    expect(engineUpdate("antigravity", "/usr/bin/agy", (p) => p)).toBeUndefined();
    expect(antigravityLaunchSpec("agy")).toEqual({ command: "agy", args: ["acp", "--dangerously-skip-permissions"] });
    expect(antigravityLaunchSpec("agy", true).args).toEqual(["acp"]);
  });

  it("names its tools the way the chat looks for them", () => {
    expect(claudeStyleToolName("Run mcp_app_set_app_kind", ["app", "pages"])).toBe("Run mcp__app__set_app_kind");
    expect(claudeStyleToolName("mcp_app_store_buy", ["app", "app_store"])).toBe("mcp__app_store__buy");
    expect(claudeStyleToolName("mcp_other_tool", ["app"])).toBe("mcp_other_tool");
    expect(claudeStyleToolName("mcp__app__ask_choice", ["app"])).toBe("mcp__app__ask_choice");
  });

  it("never picks an answer to its own question by itself", () => {
    const asked = normalizeAntigravityPermission({ sessionId: "s", toolCall: { toolCallId: "interaction_9" }, options: [{ optionId: "a", name: "A", kind: "allow_once" }] });
    expect(pickAllowOption(asked.options)).toBeUndefined();
    const tool = normalizeAntigravityPermission({ sessionId: "s", toolCall: { toolCallId: "call_1" }, options: [{ optionId: "a", name: "Allow", kind: "allow_once" }] });
    expect(pickAllowOption(tool.options)).toBe("a");
  });

  it("starts a new session with the playbook as its system prompt, on Gemini 4 Neon at high", async () => {
    const t = session();
    try {
      await t.s.start();
      expect(t.s.sessionId).toBe("agy-new");
      const seen = await t.report();
      expect(seen.args).toEqual(["acp", "--dangerously-skip-permissions"]);
      expect(seen.auth).toEqual(["oauth-personal"]);
      expect(seen.clientCapabilities.fs).toEqual({ readTextFile: false, writeTextFile: false });
      expect(seen.newMeta).toEqual({ antigravity: { systemPrompt: { append: "PLAYBOOK" } } });
      expect(seen.mcp).toEqual(MCP);
      expect(seen.config).toEqual([["model", "gemini-4-neon"], ["thought_level", "high"]]);
      // The playbook is in the system prompt, so the first prompt carries no instructions block.
      expect(seen.prompts[0]).toBe("report");
    } finally { await t.s.stop(); }
  });

  it("streams a turn: thoughts, its tool (hidden as set_app_kind), words and usage", async () => {
    const t = session();
    try {
      await t.s.start();
      expect(await t.s.prompt("make a water reminder")).toBe("end_turn");
      const tool = t.updates.find((u) => u.sessionUpdate === "tool_call");
      expect(tool.name).toBe("mcp__app__set_app_kind");
      expect(isSetAppKindCall(tool)).toBe(true);
      expect(t.said()).toBe("Made it.");
      expect(t.usage).toEqual([{ inputTokens: 120, outputTokens: 9, cacheReadTokens: 30, cacheWriteTokens: 0 }]);
      expect(t.limits.at(-1)).toMatchObject({ engine: "antigravity", kind: "antigravity_quota", status: "allowed" });
      const chat = new ChatTranslator({ cwd: process.cwd(), newId: (() => { let n = 0; return () => `i${++n}`; })() });
      const rows = t.updates.flatMap((u) => chat.translate(u)).concat(chat.finishTurn("end_turn"));
      expect(rows.filter((r) => !r.streaming).map((r) => r.kind)).toEqual(["thought", "tool", "tool", "assistant"]);
    } finally { await t.s.stop(); }
  });

  it("resumes an old session (the playbook again in _meta and, when it changed, in the first prompt)", async () => {
    const t = session({ resumeSessionId: "agy-old", instructionsOnResume: true });
    try {
      await t.s.start();
      expect(t.s.resumed).toBe(true);
      const seen = await t.report();
      expect(seen.resumeMeta).toEqual({ antigravity: { systemPrompt: { append: "PLAYBOOK" } } });
      // A resumed session lists no options: the usual ids are used.
      expect(seen.config).toEqual([["model", "gemini-4-neon"], ["thought_level", "high"]]);
      expect(seen.prompts[0]).toContain("<system_instructions>\nPLAYBOOK\n</system_instructions>");
    } finally { await t.s.stop(); }
    const gone = session({ resumeSessionId: "agy-missing" });
    try {
      await gone.s.start();
      expect(gone.s.resumed).toBe(false);
      expect(gone.s.sessionId).toBe("agy-new");
    } finally { await gone.s.stop(); }
  });

  it("says the plan needs a rest when the quota is used up", async () => {
    const t = session();
    try {
      await t.s.start();
      const error = await t.s.prompt("quota").catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect(t.limits.at(-1)).toMatchObject({ engine: "antigravity", kind: "antigravity_quota", status: "rejected" });
      expect(agentFailure(error, "antigravity")).toBe("Antigravity usage limit reached. Google says the quota for this period is used up (usage limit). Try again after the limit resets.");
    } finally { await t.s.stop(); }
  });

  it("stops a turn, and puts its own question in the chat for the person", async () => {
    const t = session();
    try {
      await t.s.start();
      const wait = t.s.prompt("wait");
      await new Promise((r) => setTimeout(r, 50));
      t.s.cancel();
      expect(await wait).toBe("cancelled");
      const turn = t.s.prompt("question");
      for (let i = 0; i < 50 && t.asks.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(t.asks[0]!.request.options.map((o) => o.kind)).toEqual(["answer", "answer"]);
      t.asks[0]!.responder.result({ outcome: { outcome: "selected", optionId: "red" } });
      expect(await turn).toBe("end_turn");
      expect(t.said()).toContain('"optionId":"red"');
    } finally { await t.s.stop(); }
  });
});
