// A minimal MCP server over streamable HTTP (JSON answers) named like Kiwimake's own: one tool,
// set_app_kind. It checks the bearer token Kiwimake's servers use, and logs each tools/call.
//   node mcp-stub.mjs <log file> <token>   -> prints the port it listens on
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const [logFile, token] = process.argv.slice(2);
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end(); }
    const msg = JSON.parse(body || "{}");
    if (msg.id === undefined) { res.writeHead(202); return res.end(); }
    const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })); };
    if (msg.method === "initialize") return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "app", version: "1" } });
    if (msg.method === "tools/list") return reply({ tools: [{ name: "set_app_kind", description: "Records the app's kind", inputSchema: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"] } }] });
    if (msg.method === "tools/call") {
      if (logFile) appendFileSync(logFile, JSON.stringify({ call: msg.params?.name, arguments: msg.params?.arguments }) + "\n");
      return reply({ content: [{ type: "text", text: "kind set" }] });
    }
    reply({});
  });
}).listen(0, "127.0.0.1", function () {
  process.stdout.write(`${this.address().port}\n`);
});
