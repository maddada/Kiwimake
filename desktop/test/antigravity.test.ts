import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectEngine } from "../src/main/detect/engine.ts";
import { AGY_AUTH_PREFIX, probeAntigravity, readAuthLine } from "../src/main/detect/antigravity.ts";
import { signInArgs, signInUrl } from "../src/main/signin.ts";
import { ENGINES, engineName } from "../../shared/engine-names.mts";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../src/main/settings.ts";

const neverRun = async () => { throw Error("must not execute"); };

describe("Antigravity in the desktop", () => {
  it("is offered as the third engine and kept in the settings", () => {
    expect(ENGINES.map(engineName)).toEqual(["Claude", "Codex", "Antigravity"]);
    const dir = mkdtempSync(join(tmpdir(), "kiwi-agy-"));
    try {
      const file = join(dir, "settings.json");
      saveSettings(file, { ...DEFAULT_SETTINGS, engine: "antigravity" });
      expect(loadSettings(file).engine).toBe("antigravity");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads the sign-in from agy's ACP answer, never its log lines", () => {
    expect(readAuthLine(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { _meta: { antigravity: { tier: { name: "Google AI Ultra" } } } } }))).toEqual({ kind: "signed-in", plan: "Google AI Ultra" });
    expect(readAuthLine(JSON.stringify({ id: 2, error: { code: -32000, message: "Authentication required" } }))).toEqual({ kind: "signed-out" });
    expect(readAuthLine(JSON.stringify({ id: 2, error: { code: -32603, message: "No browser is available here" } }))).toEqual({ kind: "signed-out" });
    expect(readAuthLine(`${AGY_AUTH_PREFIX}https://accounts.google.com/o/oauth2/auth?x=1`)).toEqual({ kind: "signed-out" });
    expect(readAuthLine(JSON.stringify({ id: 2, error: { code: -32603, message: "disk full" } }))).toEqual({ kind: "problem" });
    expect(readAuthLine("INFO starting")).toBeUndefined();
  });

  it("turns that into the setup card's state, with the plan", async () => {
    expect(await detectEngine("antigravity", "/bin/agy", neverRun, {}, async () => ({ kind: "signed-in", plan: "Google AI Pro" }))).toEqual({ state: "done", installed: true, summary: "Signed in to Antigravity (Google AI Pro)" });
    expect((await detectEngine("antigravity", "/bin/agy", neverRun, {}, async () => ({ kind: "signed-out" }))).state).toBe("needed");
    expect((await detectEngine("antigravity", "/bin/agy", neverRun, {}, async () => ({ kind: "problem" }))).state).toBe("problem");
    expect(await detectEngine("antigravity", undefined, neverRun)).toMatchObject({ installed: false, summary: "Install Antigravity to start making apps." });
  });

  it.skipIf(process.platform === "win32")("asks a running agy acp, and stops it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiwi-agy-"));
    try {
      // A stand-in agy: answers initialize, then authenticate, the way agy acp 1.5 does.
      const fake = join(dir, "agy");
      const script = join(dir, "fake-agy.mjs");
      writeFileSync(script, `import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l);
  if (m.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } }));
  if (m.method === "authenticate") console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { _meta: { antigravity: { tier: { name: process.env.BROWSER === "true" ? "No browser" : "Browser!" } } } } }));
});
setInterval(() => {}, 1000);
`);
      writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      chmodSync(fake, 0o755);
      expect(await probeAntigravity(fake, process.env, 10_000)).toEqual({ kind: "signed-in", plan: "No browser" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("signs in with agy's own ACP sign-in and keeps its Google page for Open again", () => {
    expect(signInArgs("antigravity")).toEqual(["acp", "--login"]);
    expect(signInArgs("codex")).toEqual(["login"]);
    expect(signInArgs("claude")).toEqual(["auth", "login", "--claudeai"]);
    expect(signInUrl("antigravity", `${AGY_AUTH_PREFIX}https://accounts.google.com/o/oauth2/auth?client_id=1&state=2\n`)).toBe("https://accounts.google.com/o/oauth2/auth?client_id=1&state=2");
    expect(signInUrl("antigravity", "nothing yet")).toBeUndefined();
  });
});
