// A stand-in for `agy acp` (Antigravity 1.5 over ACP) with the parts Kiwimake relies on: the
// oauth-personal sign-in, the systemPrompt append in session/new's _meta, the model and
// thought_level config options, MCP tool names as `mcp_<server>_<tool>`, its own questions as
// permission requests ("interaction_" ids), a "refusal" stop when the quota is used up, and cancel.
// The prompt "report" answers with what it was given, as JSON.
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const seen = { args: process.argv.slice(2), auth: [], newMeta: undefined, resumeMeta: undefined, config: [], prompts: [], mcp: [] };
let pending; // the prompt waiting on cancel or on a question's answer
let asked = 0;
const configOptions = (model = "gemini-4-neon", level = "high") => [
  { id: "model", category: "model", type: "select", currentValue: model, options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }, { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }] },
  { id: "thought_level", category: "thought_level", type: "select", currentValue: level, options: ["low", "medium", "high", "xhigh"].map((v) => ({ value: v, name: v })) },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  const { method, id, params: p } = msg;
  if (!method) {
    // The answer to our question.
    if (pending && String(id).startsWith("ask")) {
      const { sessionId, reply } = pending; pending = undefined;
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(msg.result) } });
      reply({ stopReason: "end_turn" });
    }
    return;
  }
  if (id === undefined) {
    if (method === "session/cancel" && pending) { const { reply } = pending; pending = undefined; reply({ stopReason: "cancelled" }); }
    return;
  }
  const reply = (result) => send({ id, result });
  if (method === "initialize") {
    seen.clientCapabilities = p.clientCapabilities;
    return reply({ protocolVersion: 1, agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" },
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { resume: {}, load: {} }, _meta: { antigravity: { tier: true, systemPrompt: { append: true } } } },
      authMethods: [{ id: "oauth-personal", name: "Log in with Google" }, { id: "gemini-api-key", name: "Gemini API key" }] });
  }
  if (method === "authenticate") { seen.auth.push(p.methodId); return reply({ _meta: { antigravity: { tier: { name: "Google AI Ultra" } } } }); }
  if (method === "session/new") {
    seen.newMeta = p._meta; seen.mcp = p.mcpServers;
    return reply({ sessionId: "agy-new", modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "auto" }] }, configOptions: configOptions("gemini-3.8-flash", "low") });
  }
  if (method === "session/resume") {
    if (p.sessionId !== "agy-old") return send({ id, error: { code: -32002, message: "Session not found" } });
    seen.resumeMeta = p._meta; seen.mcp = p.mcpServers;
    return reply({});
  }
  if (method === "session/set_config_option") { seen.config.push([p.configId, p.value]); return reply({ configOptions: configOptions() }); }
  if (method === "session/set_mode") return reply({});
  if (method === "session/prompt") {
    const text = p.prompt.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    seen.prompts.push(text);
    if (text.includes("report")) {
      update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(seen) } });
      return reply({ stopReason: "end_turn" });
    }
    if (text.includes("quota")) return reply({ stopReason: "refusal" });
    if (text.includes("wait")) { pending = { sessionId: p.sessionId, reply }; return; }
    if (text.includes("question")) {
      pending = { sessionId: p.sessionId, reply };
      send({ id: `ask${++asked}`, method: "session/request_permission", params: { sessionId: p.sessionId,
        toolCall: { toolCallId: "interaction_1", title: "Which colour?" }, options: [{ optionId: "blue", name: "Blue", kind: "allow_once" }, { optionId: "red", name: "Red", kind: "allow_once" }] } });
      return;
    }
    update(p.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking." } });
    const tool = { toolCallId: "call_1", name: "mcp_app_set_app_kind", title: "Run mcp_app_set_app_kind", kind: "other", rawInput: { kind: "android", sentence: "Reminders need an app.", toolSummary: "Set app kind" } };
    update(p.sessionId, { sessionUpdate: "tool_call", ...tool, status: "in_progress" });
    update(p.sessionId, { sessionUpdate: "tool_call_update", ...tool, status: "completed" });
    update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Made " } });
    update(p.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "it." } });
    return reply({ stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 9, cachedReadTokens: 30, cachedWriteTokens: 0, thoughtTokens: 4, totalTokens: 163 } });
  }
  send({ id, error: { code: -32601, message: `unknown ${method}` } });
});
