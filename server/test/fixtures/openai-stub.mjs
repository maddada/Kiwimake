// A stand-in for an OpenAI-compatible chat completions API (DeepSeek's, OpenCode Go's): no model,
// fixed answers, streamed as SSE with usage. When the last user message says "call <name>" and a
// tool whose name ends with <name> is offered, it calls that tool once with STUB_TOOL_ARGS, then
// answers in words. Every request is appended to the log file as one JSON line (whether the
// Authorization header carried STUB_EXPECTED_KEY, never a key itself).
//   node openai-stub.mjs <log file>   -> prints the port it listens on
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const logFile = process.argv[2];
const expectedKey = process.env.STUB_EXPECTED_KEY ?? "";
const toolArgs = process.env.STUB_TOOL_ARGS ?? "{}";

const text = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : "");

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let json = {};
    try { json = JSON.parse(body || "{}"); } catch {}
    const messages = json.messages ?? [];
    const tools = (json.tools ?? []).map((t) => t.function?.name ?? t.name);
    const lastUser = text([...messages].reverse().find((m) => m.role === "user")?.content);
    const toolResult = messages.some((m) => m.role === "tool");
    const entry = {
      path: req.url, model: json.model, stream: Boolean(json.stream), reasoningEffort: json.reasoning_effort ?? null,
      authOk: expectedKey !== "" && req.headers.authorization === `Bearer ${expectedKey}`,
      tools, lastUser: lastUser.slice(0, 300), toolResult,
      sawInstructions: messages.some((m) => text(m.content).includes("<system_instructions>")),
    };
    if (logFile) appendFileSync(logFile, JSON.stringify(entry) + "\n");
    if (!req.url.endsWith("/chat/completions")) { res.writeHead(404, { "content-type": "application/json" }); return res.end("{}"); }
    const usage = { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230, prompt_tokens_details: { cached_tokens: 800 } };
    if (!json.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "stub", object: "chat.completion", created: 1, model: json.model, choices: [{ index: 0, message: { role: "assistant", content: "A title" }, finish_reason: "stop" }], usage }));
    }
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 1, model: json.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const wanted = /call (\S+)/.exec(lastUser)?.[1];
    const tool = wanted && !toolResult ? tools.find((n) => n?.endsWith(wanted)) : undefined;
    if (tool) {
      res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: tool, arguments: "" } }] }));
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: toolArgs } }] }));
      res.write(chunk({}, "tool_calls"));
    } else {
      res.write(chunk({ role: "assistant", content: "" }));
      res.write(chunk({ content: "Done " }));
      res.write(chunk({ content: toolResult ? "with the tool." : "talking." }));
      res.write(chunk({}, "stop"));
    }
    res.write(`data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 1, model: json.model, choices: [], usage })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
}).listen(0, "127.0.0.1", function () {
  process.stdout.write(`${this.address().port}\n`);
});
