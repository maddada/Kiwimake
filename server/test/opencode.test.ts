// The cloud's OpenCode engine (server/src/acp/opencode.ts, cloud-settings.ts): settings, the
// per-session opencode.json with two providers, tool names, the launch under sudo, and real
// `opencode acp` turns through Kiwimake's own ACP session against stub OpenRouter and TheRouter
// APIs and a stub MCP tool: a normal turn, and the move to the fallback when the first provider is
// out of credit or down (no paid calls; skipped where opencode is not installed).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { cloudSettingsFromEnv, DEFAULT_CLOUD, fallbackChoice, levelChoice, OPENCODE_DEFAULT_MODEL, OPENCODE_DEFAULT_SIMPLE_MODEL } from "../src/cloud-settings.ts";
import { claudeStyleOpencodeToolName, isOpencodeProviderError, normalizeOpencodeUpdate, opencodeConfig, opencodeLaunch, opencodeMcp, opencodeProviderTrouble, opencodeTakesImages } from "../src/acp/opencode.ts";
import { createSession, resumeFor, rememberSession, sessionEngine, sessionEngineName, type SessionRecord } from "../src/acp/session.ts";
import { ClaudeSession, usageTaps } from "../src/acp/claude-session.ts";
import { loadConfig } from "../src/config.ts";
import { coordinatorPlaybook } from "../src/coordinator-playbook.ts";
import { agentFailure } from "../src/apps.ts";
import { isSetAppKindCall } from "../src/history.ts";
import { promptUsage } from "../src/usage.ts";

const MCP = [{ type: "http", name: "app", url: "http://127.0.0.1:1/mcp/app/x", headers: [{ name: "Authorization", value: "Bearer tools-token" }] }];

describe("the cloud's engine setting", () => {
  it("stays Claude unless the cloud asks for OpenCode", () => {
    expect(cloudSettingsFromEnv({})).toBeUndefined();
    const claude = cloudSettingsFromEnv({ ANYAPP_CLOUD: "1" })!;
    expect(claude.engine).toBe("claude");
    expect(claude.orchestrator).toEqual(DEFAULT_CLOUD.orchestrator);
    expect(claude.opencode).toBeUndefined();
    expect(() => cloudSettingsFromEnv({ ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "gpt" })).toThrow(/claude" or "opencode/);
  });

  it("runs OpenCode on OpenRouter by default, falling back to TheRouter, on each one's newest DeepSeek", () => {
    const s = cloudSettingsFromEnv({ ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode", ANYAPP_AGENT_PREFIX: '["sudo","-n","-u","agent"]' })!;
    expect(s.engine).toBe("opencode");
    expect(s.opencode).toEqual({
      provider: { id: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", name: "OpenRouter" },
      fallback: {
        provider: { id: "therouter", npm: "@ai-sdk/openai-compatible", baseURL: "https://api.therouter.ai/v1", apiKeyEnv: "THEROUTER_API_KEY", name: "TheRouter" },
        model: "therouter/deepseek/deepseek-v4-pro", simpleModel: "therouter/deepseek/deepseek-v4-flash",
      },
      cli: "opencode",
    });
    expect(OPENCODE_DEFAULT_MODEL).toBe("openrouter/deepseek/deepseek-v4-pro-0813");
    expect(OPENCODE_DEFAULT_SIMPLE_MODEL).toBe("openrouter/deepseek/deepseek-v4.1-flash-1017");
    expect(s.orchestrator).toEqual({ model: OPENCODE_DEFAULT_MODEL, effort: "high" });
    expect(levelChoice(s, "deep")).toEqual({ model: OPENCODE_DEFAULT_MODEL, effort: "high" });
    // DeepSeek has no "medium" effort: focused runs at the model's default.
    expect(levelChoice(s, "focused")).toEqual({ model: OPENCODE_DEFAULT_MODEL, effort: "default" });
    expect(levelChoice(s, "simple")).toEqual({ model: OPENCODE_DEFAULT_SIMPLE_MODEL, effort: "high" });
    expect(fallbackChoice(s, s.orchestrator, false)).toEqual({ model: "therouter/deepseek/deepseek-v4-pro", effort: "high" });
    expect(fallbackChoice(s, levelChoice(s, "simple"), true)).toEqual({ model: "therouter/deepseek/deepseek-v4-flash", effort: "high" });
    expect(s.agentPrefix).toEqual(["sudo", "-n", "-u", "agent"]);
    // TheRouter first falls back to OpenRouter.
    const t = cloudSettingsFromEnv({ ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode", ANYAPP_OPENCODE_PROVIDER: "therouter" })!;
    expect([t.orchestrator.model, t.opencode!.fallback!.model]).toEqual(["therouter/deepseek/deepseek-v4-pro", "openrouter/deepseek/deepseek-v4-pro-0813"]);
  });

  it("switches models with settings alone: any model on the provider, another fallback, or none", () => {
    const s = cloudSettingsFromEnv({
      ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode", ANYAPP_OPENCODE_PROVIDER: "openrouter",
      ANYAPP_OPENCODE_MODEL: "openrouter/moonshotai/kimi-k3", ANYAPP_OPENCODE_FALLBACK_PROVIDER: "none",
      ANYAPP_OPENCODE_CLI: "/opt/npm/bin/opencode", ANYAPP_OPENCODE_CONFIG_DIR: "/data/apps/.opencode",
    })!;
    // A model named without a simple one: simple work uses it too.
    expect([s.orchestrator.model, levelChoice(s, "simple").model]).toEqual(["openrouter/moonshotai/kimi-k3", "openrouter/moonshotai/kimi-k3"]);
    expect(s.opencode!.fallback).toBeUndefined();
    expect(fallbackChoice(s, s.orchestrator, false)).toBeUndefined();
    expect(s.opencode!.cli).toBe("/opt/npm/bin/opencode");
    expect(s.opencode!.configDir).toBe("/data/apps/.opencode");
    const go = cloudSettingsFromEnv({ ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode", ANYAPP_OPENCODE_PROVIDER: "opencode-go", ANYAPP_OPENCODE_FALLBACK_PROVIDER: "deepseek" })!;
    expect([go.orchestrator.model, go.opencode!.fallback!.model]).toEqual(["opencode-go/deepseek-v4-pro", "deepseek/deepseek-v4-pro"]);
    // A provider given as JSON (a stub) keeps what Kiwimake knows of a known id, and takes the rest.
    const stub = cloudSettingsFromEnv({ ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode", ANYAPP_OPENCODE_PROVIDER: '{"id":"therouter","apiKeyEnv":"THEROUTER_API_KEY","baseURL":"http://127.0.0.1:9/v1"}', ANYAPP_OPENCODE_FALLBACK_PROVIDER: "none" })!;
    expect(stub.opencode!.provider).toEqual({ id: "therouter", apiKeyEnv: "THEROUTER_API_KEY", npm: "@ai-sdk/openai-compatible", baseURL: "http://127.0.0.1:9/v1", name: "TheRouter" });
    // Refused: a model of another provider, an unknown provider, a fallback that is the same provider.
    expect(() => cloudSettingsFromEnv({ ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode", ANYAPP_OPENCODE_MODEL: "therouter/deepseek/deepseek-v4-pro" })).toThrow(/openrouter\/<model>/);
    expect(() => cloudSettingsFromEnv({ ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode", ANYAPP_OPENCODE_PROVIDER: "acme" })).toThrow(/must be one of openrouter, therouter/);
    expect(() => cloudSettingsFromEnv({ ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode", ANYAPP_OPENCODE_FALLBACK_PROVIDER: "openrouter" })).toThrow(/another provider/);
    expect(() => cloudSettingsFromEnv({ ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode", ANYAPP_OPENCODE_PROVIDER: '{"id":"x","apiKeyEnv":"lower case"}' })).toThrow(/ANYAPP_OPENCODE_PROVIDER/);
    expect(() => cloudSettingsFromEnv({ ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode", ANYAPP_OPENCODE_PROVIDER: '{"id":"acme","apiKeyEnv":"ACME_KEY"}', ANYAPP_OPENCODE_FALLBACK_PROVIDER: "none" })).toThrow(/acme\/<model>/);
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

  it("writes a config with both providers, each key only as an environment variable, full access and plain MCP tools", () => {
    const c = opencodeConfig(settings, { model: OPENCODE_DEFAULT_MODEL, effort: "high" }, MCP, OPENCODE_DEFAULT_SIMPLE_MODEL) as any;
    expect(c.model).toBe("openrouter/deepseek/deepseek-v4-pro-0813");
    expect(c.small_model).toBe("openrouter/deepseek/deepseek-v4.1-flash-1017");
    expect(c.enabled_providers).toEqual(["openrouter", "therouter"]);
    expect(c.provider).toEqual({
      openrouter: { name: "OpenRouter", options: { apiKey: "{env:OPENROUTER_API_KEY}" }, models: { "deepseek/deepseek-v4-pro-0813": {}, "deepseek/deepseek-v4.1-flash-1017": {} } },
      therouter: {
        npm: "@ai-sdk/openai-compatible", name: "TheRouter",
        options: { baseURL: "https://api.therouter.ai/v1", apiKey: "{env:THEROUTER_API_KEY}", includeUsage: true },
        models: { "deepseek/deepseek-v4-pro": {}, "deepseek/deepseek-v4-flash": {} },
      },
    });
    expect(c.mcp).toEqual({ app: { type: "remote", url: MCP[0]!.url, headers: { Authorization: "Bearer tools-token" }, codemode: false, oauth: false } });
    expect(c.permission["*"]).toBe("allow");
    for (const tool of ["question", "subagent", "execute", "generate_image", "generate_video", "websearch", "automation_*", "opencode_*"]) expect(c.permission[tool]).toBe("deny");
    expect(c.autoupdate).toBe(false);
    expect(c.share).toBe("disabled");
    expect(JSON.stringify(c)).not.toMatch(/sk-|oc_sk_/);
    expect(opencodeMcp([{ type: "stdio", name: "x" }, "junk"])).toEqual({});
  });

  it("knows a failing provider: refused at once, or retried by OpenCode", () => {
    expect(isOpencodeProviderError(new Error('Internal error: Insufficient credits: {"service":"session","errorName":"provider.quota"}'))).toBe(true);
    expect(isOpencodeProviderError(new Error("The agent session is not running"))).toBe(false);
    const retry = (attempt: number) => ({ sessionUpdate: "session_info_update", _meta: { "opencode/retry": { attempt, error: { type: "provider.internal", status: 503 } } } });
    expect(opencodeProviderTrouble(retry(2))).toBeUndefined();
    expect(opencodeProviderTrouble(retry(3))).toBe("provider.internal 503, 3 tries");
    expect(opencodeProviderTrouble({ sessionUpdate: "session_info_update", _meta: { "opencode/retry": null } })).toBeUndefined();
    expect(opencodeTakesImages("openrouter/deepseek/deepseek-v4-pro-0813")).toBe(false);
    expect(opencodeTakesImages("openrouter/deepseek/deepseek-v4.1-flash-1017")).toBe(true);
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
      const { launch, env, configPath } = opencodeLaunch({ ...settings, configDir: dir }, { model: OPENCODE_DEFAULT_MODEL, effort: "high" }, MCP, prefix, "/unused");
      expect(launch.command).toBe("sudo");
      expect(launch.args).toEqual([...prefix.slice(1), "env", `OPENCODE_CONFIG=${configPath}`, "OPENCODE_DISABLE_AUTOUPDATE=1", "OPENCODE_DISABLE_FREE_MODELS=1", "opencode", "acp"]);
      expect(env).toEqual({});
      expect(configPath.startsWith(dir)).toBe(true);
      expect(statSync(configPath).mode & 0o777).toBe(0o640);
      expect(JSON.parse(readFileSync(configPath, "utf8")).model).toBe(OPENCODE_DEFAULT_MODEL);
      const local = opencodeLaunch({ ...settings, configDir: dir }, { model: OPENCODE_DEFAULT_MODEL, effort: "high" }, [], [], "/unused");
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
    // Kiwimake's own provider accounts: never the provider's words or its credit page.
    expect(agentFailure(new Error("Rate limit reached for requests"), "opencode")).toBe("Kiwimake's AI is not available right now. Try again in a few minutes.");
    expect(agentFailure(new Error('Internal error: Insufficient credits. Add more using https://openrouter.ai/settings/credits: {"service":"session","errorName":"provider.quota"}'), "opencode")).toBe("Kiwimake's AI is not available right now. Try again in a few minutes.");
    expect(agentFailure(new Error("Rate limit reached"), "claude")).toMatch(/^Claude usage limit reached/);
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

interface Stub { child: ChildProcess; port: number; log: string }

describe.skipIf(!OPENCODE)("a real opencode acp turn (stub providers, no paid calls)", () => {
  let dir = "";
  const stubs: Stub[] = [];
  let tools: { child: ChildProcess; port: number };
  const KEYS = { OPENROUTER_API_KEY: `or-${Math.random().toString(36).slice(2)}`, THEROUTER_API_KEY: `tr-${Math.random().toString(36).slice(2)}` };
  const TOKEN = "tools-token-123";

  async function stub(name: string, key: string, fail?: number): Promise<Stub> {
    const log = join(dir, `${name}.jsonl`);
    const s = await startFixture("openai-stub.mjs", [log], { STUB_EXPECTED_KEY: key, STUB_TOOL_ARGS: JSON.stringify({ kind: "android" }), ...(fail ? { STUB_FAIL: String(fail) } : {}) });
    stubs.push({ ...s, log });
    return { ...s, log };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "kiwi-oc-e2e-"));
    tools = await startFixture("mcp-stub.mjs", [join(dir, "mcp.jsonl"), TOKEN]);
  });
  afterAll(() => {
    for (const s of stubs) s.child.kill();
    tools?.child.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * One session as the cloud makes it: OpenRouter first (OpenCode's own provider, aimed at a stub)
   * and TheRouter as the fallback (the OpenAI-compatible package, aimed at another stub).
   */
  function cloudSession(name: string, first: Stub, second: Stub, tag?: Record<string, string>) {
    const config = loadConfig({
      ANYAPP_CLOUD: "1", ANYAPP_CLOUD_ENGINE: "opencode", ANYAPP_STATE_DIR: join(dir, name, "state"), ANYAPP_APPS_DIR: join(dir, name, "apps"),
      ANYAPP_OPENCODE_PROVIDER: JSON.stringify({ id: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", baseURL: `http://127.0.0.1:${first.port}/v1` }),
      ANYAPP_OPENCODE_FALLBACK_PROVIDER: JSON.stringify({ id: "therouter", apiKeyEnv: "THEROUTER_API_KEY", baseURL: `http://127.0.0.1:${second.port}/v1` }),
      ANYAPP_OPENCODE_CLI: OPENCODE!, ANYAPP_OPENCODE_CONFIG_DIR: join(dir, name, "opencode-config"),
    });
    const home = join(dir, name, "home");
    const work = join(dir, name, "apps", "teatimer");
    spawnSync("mkdir", ["-p", work, home]);
    const t = { updates: [] as any[], usage: [] as any[], taps: [] as any[], logs: [] as string[], fallbacks: [] as any[] };
    const tap = (u: any) => t.taps.push(u);
    usageTaps.add(tap);
    const session = createSession(config, {
      cwd: work,
      instructions: "KIWI PLAYBOOK",
      mcpServers: [{ type: "http", name: "app", url: `http://127.0.0.1:${tools.port}/mcp`, headers: [{ name: "Authorization", value: `Bearer ${TOKEN}` }] }],
      // Its own home, so this never touches the person's own opencode, its sessions or its service.
      env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"), ...KEYS },
      ...(tag ? { tag } : {}),
      onUpdate: (u) => t.updates.push(u), onUsage: (u) => t.usage.push(u),
      onPermission: (ask) => { throw new Error(`no permission request expected: ${JSON.stringify(ask.request.toolCall)}`); },
      onFallback: (f) => t.fallbacks.push(f),
      onExit: () => {}, log: (m) => t.logs.push(m),
    }) as ClaudeSession;
    const said = () => t.updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("");
    return { session, ...t, said, stop: async () => { usageTaps.delete(tap); await session.stop(); } };
  }

  it("runs the orchestrator on OpenRouter's DeepSeek V4 Pro at high, with the playbook, Kiwimake's tools by name, and usage", async () => {
    const or = await stub("ok-openrouter", KEYS.OPENROUTER_API_KEY);
    const tr = await stub("ok-therouter", KEYS.THEROUTER_API_KEY);
    const t = cloudSession("ok", or, tr);
    expect(t.session).toBeInstanceOf(ClaudeSession);
    try {
      await t.session.start();
      expect(t.session.sessionId).toMatch(/^ses_/);
      // DeepSeek V4 Pro takes no pictures: they go as a line naming the file.
      expect(t.session.supportsImageInput).toBe(false);
      expect(t.logs.join("\n")).toContain("openrouter/deepseek/deepseek-v4-pro-0813 at high");

      expect(await t.session.prompt("Say hello.")).toBe("end_turn");
      expect(await t.session.prompt("Please call set_app_kind")).toBe("end_turn");

      // The agent's own turns carry tools; the session title is asked of the small model (Flash).
      const all = lines(or.log);
      const asked = all.filter((e) => e.stream && e.tools.length > 0);
      expect(asked.length).toBe(3);
      expect(all.filter((e) => e.tools.length === 0).every((e) => e.model === "deepseek/deepseek-v4.1-flash-1017")).toBe(true);
      for (const e of asked) {
        expect(e.model).toBe("deepseek/deepseek-v4-pro-0813");
        expect(e.authOk).toBe(true);
        // Kiwimake's tool as a plain tool; none of OpenCode's own that a phone user cannot answer.
        expect(e.tools).toContain("app_set_app_kind");
        for (const x of ["execute", "question", "subagent", "generate_image", "generate_video", "websearch"]) expect(e.tools).not.toContain(x);
      }
      expect(asked[0].sawInstructions).toBe(true);
      // Nothing went to the fallback while the first provider answered.
      expect(lines(tr.log)).toEqual([]);

      expect(lines(join(dir, "mcp.jsonl"))).toEqual([{ call: "set_app_kind", arguments: { kind: "android" } }]);
      const call = t.updates.find((u) => u.sessionUpdate === "tool_call");
      expect(call.title).toBe("mcp__app__set_app_kind");
      expect(isSetAppKindCall(call)).toBe(true);
      expect(t.said()).toContain("Done talking.");
      expect(t.said()).toContain("Done with the tool.");

      expect(t.usage.length).toBe(2);
      expect(t.usage[0]).toMatchObject({ inputTokens: 400, outputTokens: 30, cacheReadTokens: 800 });
      expect(t.taps.map((u) => u.model)).toEqual(["openrouter/deepseek/deepseek-v4-pro-0813", "openrouter/deepseek/deepseek-v4-pro-0813"]);
      expect(t.fallbacks).toEqual([]);
    } finally {
      await t.stop();
    }
  }, 180_000);

  it("moves a turn to TheRouter when OpenRouter is out of credit, and counts it on TheRouter's model", async () => {
    const or = await stub("broke-openrouter", KEYS.OPENROUTER_API_KEY, 402);
    const tr = await stub("broke-therouter", KEYS.THEROUTER_API_KEY);
    const t = cloudSession("broke", or, tr);
    try {
      await t.session.start();
      expect(await t.session.prompt("Please call set_app_kind")).toBe("end_turn");
      expect(t.fallbacks).toEqual([{ from: "openrouter/deepseek/deepseek-v4-pro-0813", to: "therouter/deepseek/deepseek-v4-pro", reason: expect.stringMatching(/Insufficient credits/) }]);
      expect(t.session.model).toBe("therouter/deepseek/deepseek-v4-pro");
      const asked = lines(tr.log).filter((e) => e.stream && e.tools.length > 0);
      expect(asked.length).toBeGreaterThanOrEqual(2);
      for (const e of asked) {
        expect(e.model).toBe("deepseek/deepseek-v4-pro");
        expect(e.authOk).toBe(true);
        expect(e.tools).toContain("app_set_app_kind");
      }
      // The same prompt, with the playbook, ran again on the fallback; its tool worked there.
      expect(asked[0].sawInstructions).toBe(true);
      expect(t.updates.find((u) => u.sessionUpdate === "tool_call")?.title).toBe("mcp__app__set_app_kind");
      expect(t.said()).toContain("Done with the tool.");
      // Priced on the model that did the work (TheRouter's).
      expect(t.taps.length).toBeGreaterThan(0);
      expect(t.taps.every((u) => u.model === "therouter/deepseek/deepseek-v4-pro")).toBe(true);
      // The next turn stays on the fallback.
      expect(await t.session.prompt("Say hello.")).toBe("end_turn");
      expect(t.fallbacks.length).toBe(1);
    } finally {
      await t.stop();
    }
  }, 180_000);

  it("moves a turn to TheRouter when OpenRouter is down (OpenCode retrying), simple work on Flash", async () => {
    const or = await stub("down-openrouter", KEYS.OPENROUTER_API_KEY, 503);
    const tr = await stub("down-therouter", KEYS.THEROUTER_API_KEY);
    const t = cloudSession("down", or, tr, { role: "helper", workerId: "w1", level: "simple" });
    try {
      await t.session.start();
      const t0 = Date.now();
      expect(await t.session.prompt("Say hello.")).toBe("end_turn");
      expect(t.fallbacks).toEqual([{ from: "openrouter/deepseek/deepseek-v4-pro-0813", to: "therouter/deepseek/deepseek-v4-flash", reason: "provider.internal 503, 3 tries" }]);
      expect(t.said()).toContain("Done talking.");
      expect(lines(tr.log).some((e) => e.stream && e.model === "deepseek/deepseek-v4-flash")).toBe(true);
      // OpenCode's retries before the move take seconds, not minutes.
      expect(Date.now() - t0).toBeLessThan(60_000);
    } finally {
      await t.stop();
    }
  }, 180_000);
});
