// The cloud's OpenCode engine (server/src/acp/opencode.ts, cloud-settings.ts): settings, the
// per-session opencode.json, tool names, the launch under sudo, and a real `opencode acp` turn
// through Kiwimake's own ACP session against a stub DeepSeek API and a stub MCP tool (no paid
// calls; skipped where opencode is not installed).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { cloudSettingsFromEnv, DEFAULT_CLOUD, levelChoice, OPENCODE_DEFAULT_MODEL, OPENCODE_DEFAULT_SIMPLE_MODEL } from "../src/cloud-settings.ts";
import { claudeStyleOpencodeToolName, normalizeOpencodeUpdate, opencodeConfig, opencodeLaunch, opencodeMcp } from "../src/acp/opencode.ts";
import { createSession, resumeFor, rememberSession, sessionEngine, sessionEngineName, type SessionRecord } from "../src/acp/session.ts";
import { ClaudeSession } from "../src/acp/claude-session.ts";
import { loadConfig } from "../src/config.ts";
import { coordinatorPlaybook } from "../src/coordinator-playbook.ts";
import { agentFailure } from "../src/apps.ts";
import { isSetAppKindCall } from "../src/history.ts";
import { promptUsage } from "../src/usage.ts";

const MCP = [{ type: "http", name: "app", url: "http://127.0.0.1:1/mcp/app/x", headers: [{ name: "Authorization", value: "Bearer tools-token" }] }];
const STUB_PROVIDER = (baseURL: string) => JSON.stringify({ id: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY", baseURL });

describe("the cloud's engine setting", () => {
  it("stays Claude unless the cloud asks for OpenCode", () => {
    expect(cloudSettingsFromEnv({})).toBeUndefined();
    const claude = cloudSettingsFromEnv({ ANYAPP_CLOUD: "1" })!;
    expect(claude.engine).toBe("claude");
    expect(claude.orchestrator).toEqual(DEFAULT_CLOUD.orchestrator);
    expect(claude.opencode).toBeUndefined();
    expect(() => cloudSettingsFromEnv({ ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "gpt" })).toThrow(/claude" or "opencode/);
  });

  it("runs OpenCode on DeepSeek's own API by default, V4 Pro for the work and Flash for simple work", () => {
    const s = cloudSettingsFromEnv({ ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode", ANYAPP_AGENT_PREFIX: '["sudo","-n","-u","agent"]' })!;
    expect(s.engine).toBe("opencode");
    expect(s.opencode).toEqual({ provider: { id: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" }, cli: "opencode" });
    expect(s.orchestrator).toEqual({ model: OPENCODE_DEFAULT_MODEL, effort: "high" });
    expect(OPENCODE_DEFAULT_MODEL).toBe("deepseek/deepseek-v4-pro");
    expect(levelChoice(s, "deep")).toEqual({ model: "deepseek/deepseek-v4-pro", effort: "high" });
    // DeepSeek has no "medium" effort: focused runs at the model's default.
    expect(levelChoice(s, "focused")).toEqual({ model: "deepseek/deepseek-v4-pro", effort: "default" });
    expect(levelChoice(s, "simple")).toEqual({ model: OPENCODE_DEFAULT_SIMPLE_MODEL, effort: "high" });
    expect(s.agentPrefix).toEqual(["sudo", "-n", "-u", "agent"]);
  });

  it("takes another provider (OpenCode Go for the owner's own tests) with its own models", () => {
    const s = cloudSettingsFromEnv({
      ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode",
      ANYAPP_OPENCODE_PROVIDER: '{"id":"opencode-go","apiKeyEnv":"OPENCODE_API_KEY"}',
      ANYAPP_OPENCODE_MODEL: "opencode-go/deepseek-v4-pro", ANYAPP_OPENCODE_SIMPLE_MODEL: "opencode-go/deepseek-v4.1-flash",
      ANYAPP_OPENCODE_CLI: "/opt/npm/bin/opencode", ANYAPP_OPENCODE_CONFIG_DIR: "/data/apps/.opencode",
    })!;
    expect(s.opencode).toEqual({ provider: { id: "opencode-go", apiKeyEnv: "OPENCODE_API_KEY" }, cli: "/opt/npm/bin/opencode", configDir: "/data/apps/.opencode" });
    expect(levelChoice(s, "simple").model).toBe("opencode-go/deepseek-v4.1-flash");
    // A model of another provider, or no model for a provider without defaults, is refused.
    expect(() => cloudSettingsFromEnv({ ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode", ANYAPP_OPENCODE_MODEL: "opencode-go/deepseek-v4-pro" })).toThrow(/deepseek\/<model>/);
    expect(() => cloudSettingsFromEnv({ ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode", ANYAPP_OPENCODE_PROVIDER: '{"id":"opencode-go","apiKeyEnv":"OPENCODE_API_KEY"}' })).toThrow(/opencode-go\/<model>/);
    expect(() => cloudSettingsFromEnv({ ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode", ANYAPP_OPENCODE_PROVIDER: '{"id":"deepseek","apiKeyEnv":"lower case"}' })).toThrow(/ANYAPP_OPENCODE_PROVIDER/);
  });

  it("keeps one session per engine, so switching the cloud's engine never resumes the other agent's session", () => {
    const record: SessionRecord = { sessionId: "claude-1", sessionEngine: "claude" };
    expect(resumeFor(record, "opencode")).toBeUndefined();
    rememberSession(record, "opencode", "ses_1");
    expect(resumeFor(record, "opencode")).toBe("ses_1");
    expect(resumeFor(record, "claude")).toBe("claude-1");
    expect(sessionEngine({ cloud: cloudSettingsFromEnv({ ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode" }) })).toBe("opencode");
    expect(sessionEngine({ cloud: cloudSettingsFromEnv({ ANYAPP_CLOUD: "1" }) })).toBe("claude");
    expect(sessionEngine({ engine: "codex" })).toBe("codex");
  });
});

describe("OpenCode's config and names", () => {
  const settings = cloudSettingsFromEnv({ ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode" })!.opencode!;

  it("writes a config with the key only as an environment variable, full access and plain MCP tools", () => {
    const c = opencodeConfig(settings, { model: "deepseek/deepseek-v4-pro", effort: "high" }, MCP, "deepseek/deepseek-flash") as any;
    expect(c.model).toBe("deepseek/deepseek-v4-pro");
    expect(c.small_model).toBe("deepseek/deepseek-flash");
    expect(c.enabled_providers).toEqual(["deepseek"]);
    expect(c.provider).toEqual({ deepseek: { options: { apiKey: "{env:DEEPSEEK_API_KEY}" }, models: { "deepseek-v4-pro": {}, "deepseek-flash": {} } } });
    expect(c.mcp).toEqual({ app: { type: "remote", url: MCP[0]!.url, headers: { Authorization: "Bearer tools-token" }, codemode: false, oauth: false } });
    expect(c.permission["*"]).toBe("allow");
    for (const tool of ["question", "subagent", "execute", "generate_image", "generate_video", "websearch", "automation_*", "opencode_*"]) expect(c.permission[tool]).toBe("deny");
    expect(c.autoupdate).toBe(false);
    expect(c.share).toBe("disabled");
    expect(JSON.stringify(c)).not.toMatch(/sk-|oc_sk_/);
    expect(opencodeMcp([{ type: "stdio", name: "x" }, "junk"])).toEqual({});
  });

  it("names Kiwimake's own tools the way the chat looks for them", () => {
    expect(claudeStyleOpencodeToolName("app_set_app_kind", ["app", "pages"])).toBe("mcp__app__set_app_kind");
    expect(claudeStyleOpencodeToolName("app_store_buy", ["app", "app_store"])).toBe("mcp__app_store__buy");
    expect(claudeStyleOpencodeToolName("edit", ["app"])).toBe("edit");
    expect(claudeStyleOpencodeToolName("app_", ["app"])).toBe("app_");
    const u = normalizeOpencodeUpdate({ sessionUpdate: "tool_call", toolCallId: "c", name: "app_set_app_kind", title: "app_set_app_kind" }, ["app"]) as Record<string, unknown>;
    expect(isSetAppKindCall(u)).toBe(true);
    expect(normalizeOpencodeUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "app_x" } }, ["app"])).toEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "app_x" } });
  });

  it("launches under the agent's Unix user with the config path after sudo, never a key on the command line", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiwi-oc-launch-"));
    try {
      const prefix = ["sudo", "-n", "-u", "agent", "-H", "/opt/kiwi/agent.sh"];
      const { launch, env, configPath } = opencodeLaunch({ ...settings, configDir: dir }, { model: "deepseek/deepseek-v4-pro", effort: "high" }, MCP, prefix, "/unused");
      expect(launch.command).toBe("sudo");
      expect(launch.args).toEqual([...prefix.slice(1), "env", `OPENCODE_CONFIG=${configPath}`, "OPENCODE_DISABLE_AUTOUPDATE=1", "OPENCODE_DISABLE_FREE_MODELS=1", "opencode", "acp"]);
      expect(env).toEqual({});
      expect(configPath.startsWith(dir)).toBe(true);
      expect(statSync(configPath).mode & 0o777).toBe(0o640);
      expect(JSON.parse(readFileSync(configPath, "utf8")).model).toBe("deepseek/deepseek-v4-pro");
      const local = opencodeLaunch({ ...settings, configDir: dir }, { model: "deepseek/deepseek-v4-pro", effort: "high" }, [], [], "/unused");
      expect(local.launch).toEqual({ command: "opencode", args: ["acp"] });
      expect(local.env.OPENCODE_CONFIG).toBe(local.configPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never calls the cloud's agent Claude Code, and names it Kiwimake's AI in errors", () => {
    const app = { name: "Tea Timer", packageName: "com.anyappcloud.teatimer", dir: "/data/apps/teatimer", preset: "react-native" as const };
    const text = coordinatorPlaybook(app, { cloud: true, poweredBy: "DeepSeek" });
    expect(text).toContain("you are Kiwimake's AI agent, powered by DeepSeek");
    expect(text).not.toContain("powered by Claude");
    expect(coordinatorPlaybook(app, { cloud: true })).toContain("powered by Claude");
    expect(sessionEngineName("opencode")).toBe("Kiwimake's AI");
    expect(agentFailure(new Error("Rate limit reached for requests"), "opencode")).toMatch(/^Kiwimake's AI usage limit reached/);
    expect(agentFailure(new Error("Insufficient credits"), "opencode")).toMatch(/^Kiwimake's AI has no credits left/);
  });
});

// ---------- a real `opencode acp` turn against stubs

function findOpencode(): string | undefined {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const r = spawnSync("sh", ["-c", "command -v opencode"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}
const OPENCODE = findOpencode();
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

async function startFixture(name: string, args: string[], env: Record<string, string> = {}): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, [join(FIXTURES, name), ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve) => createInterface({ input: child.stdout! }).once("line", (l) => resolve(Number(l))));
  return { child, port };
}

const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

describe.skipIf(!OPENCODE)("a real opencode acp turn (stub provider, no paid calls)", () => {
  let dir = "";
  let provider: { child: ChildProcess; port: number };
  let tools: { child: ChildProcess; port: number };
  const KEY = `stub-key-${Math.random().toString(36).slice(2)}`;
  const TOKEN = "tools-token-123";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-oc-e2e-"));
    provider = await startFixture("openai-stub.mjs", [join(dir, "provider.jsonl")], { STUB_EXPECTED_KEY: KEY, STUB_TOOL_ARGS: JSON.stringify({ kind: "android" }) });
    tools = await startFixture("mcp-stub.mjs", [join(dir, "mcp.jsonl"), TOKEN]);
  });
  afterAll(() => {
    provider?.child.kill();
    tools?.child.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("runs the orchestrator on DeepSeek V4 Pro at high, with the playbook, Kiwimake's tools by name, and usage", async () => {
    const config = loadConfig({
      ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode", ANYAPP_STATE_DIR: join(dir, "state"), ANYAPP_APPS_DIR: join(dir, "apps"),
      ANYAPP_OPENCODE_PROVIDER: STUB_PROVIDER(`http://127.0.0.1:${provider.port}/v1`), ANYAPP_OPENCODE_CLI: OPENCODE!,
      ANYAPP_OPENCODE_CONFIG_DIR: join(dir, "opencode-config"),
    });
    const home = join(dir, "home");
    const work = join(dir, "apps", "teatimer");
    spawnSync("mkdir", ["-p", work, home]);
    const updates: any[] = [];
    const usage: any[] = [];
    const logs: string[] = [];
    const session = createSession(config, {
      cwd: work,
      instructions: "KIWI PLAYBOOK",
      mcpServers: [{ type: "http", name: "app", url: `http://127.0.0.1:${tools.port}/mcp`, headers: [{ name: "Authorization", value: `Bearer ${TOKEN}` }] }],
      // Its own home, so this never touches the person's own opencode, its sessions or its service.
      env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"), DEEPSEEK_API_KEY: KEY },
      onUpdate: (u) => updates.push(u), onUsage: (u) => usage.push(u),
      onPermission: (ask) => { throw new Error(`no permission request expected: ${JSON.stringify(ask.request.toolCall)}`); },
      onExit: () => {}, log: (m) => logs.push(m),
    }) as ClaudeSession;
    expect(session).toBeInstanceOf(ClaudeSession);
    try {
      await session.start();
      expect(session.sessionId).toMatch(/^ses_/);
      // DeepSeek V4 Pro takes no pictures: they go as a line naming the file.
      expect(session.supportsImageInput).toBe(false);
      expect(logs.join("\n")).toContain("deepseek/deepseek-v4-pro at high");

      expect(await session.prompt("Say hello.")).toBe("end_turn");
      expect(await session.prompt("Please call set_app_kind")).toBe("end_turn");

      // The agent's own turns carry tools; the session title is asked of the small model (Flash).
      const all = lines(join(dir, "provider.jsonl"));
      const asked = all.filter((e) => e.stream && e.tools.length > 0);
      expect(asked.length).toBe(3);
      expect(all.filter((e) => e.tools.length === 0).every((e) => e.model === "deepseek-flash")).toBe(true);
      for (const e of asked) {
        expect(e.model).toBe("deepseek-v4-pro");
        expect(e.authOk).toBe(true);
        expect(e.reasoningEffort).toBe("high");
        // Kiwimake's tool as a plain tool; none of OpenCode's own that a phone user cannot answer.
        expect(e.tools).toContain("app_set_app_kind");
        for (const t of ["execute", "question", "subagent", "generate_image", "generate_video", "websearch"]) expect(e.tools).not.toContain(t);
      }
      expect(asked[0].sawInstructions).toBe(true);
      // Every request went to the stub: titles use the same provider (small_model), nothing else.
      expect(lines(join(dir, "provider.jsonl")).every((e) => e.model === "deepseek-v4-pro" || e.model === "deepseek-flash")).toBe(true);

      expect(lines(join(dir, "mcp.jsonl"))).toEqual([{ call: "set_app_kind", arguments: { kind: "android" } }]);
      const call = updates.find((u) => u.sessionUpdate === "tool_call");
      expect(call.title).toBe("mcp__app__set_app_kind");
      expect(isSetAppKindCall(call)).toBe(true);
      const said = updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("");
      expect(said).toContain("Done talking.");
      expect(said).toContain("Done with the tool.");

      expect(usage.length).toBe(2);
      expect(usage[0]).toMatchObject({ inputTokens: 400, outputTokens: 30, cacheReadTokens: 800 });
      expect(promptUsage({ usage: { inputTokens: 400, outputTokens: 30, cachedReadTokens: 800 } })).toEqual(usage[0]);
    } finally {
      await session.stop();
    }
  }, 180_000);
});
