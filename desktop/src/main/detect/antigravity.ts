// Is Antigravity (`agy`) signed in on this PC? Its CLI has no "login status" command, so this asks
// the way t3code does: start `agy acp`, send ACP's initialize and the "oauth-personal" authenticate,
// and read the answer. Signed in: the answer names the plan ("Google AI Ultra"). Not signed in:
// an ACP auth error, or the sign-in link it prints. It must never open a browser by itself, so
// BROWSER is a command that does nothing, and the process is stopped as soon as the answer is in.
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { killTree, spawnHidden } from "../exec.ts";

export type AntigravityAuth =
  | { kind: "signed-in"; plan?: string }
  | { kind: "signed-out" }
  | { kind: "problem" };

/** The sign-in link `agy acp` prints when it has no sign-in (t3code: ANTIGRAVITY_AUTH_STDOUT_PREFIX). */
export const AGY_AUTH_PREFIX = "Open the following link to authenticate the ACP server: ";

/** What one line of `agy acp` output says about the sign-in, if anything. */
export function readAuthLine(line: string): AntigravityAuth | undefined {
  if (line.includes(AGY_AUTH_PREFIX) || /https:\/\/accounts\.google\.com\/o\/oauth2\//.test(line)) return { kind: "signed-out" };
  let msg: any;
  try { msg = JSON.parse(line); } catch { return undefined; }
  if (!msg || msg.id !== 2) return undefined;
  if (msg.error) {
    const text = String(msg.error.message ?? "");
    // -32000 is ACP's auth_required; 1.5 says "No browser is available here" without a display.
    return msg.error.code === -32000 || /no browser is available|sign.?in|log.?in|auth/i.test(text) ? { kind: "signed-out" } : { kind: "problem" };
  }
  const plan = msg.result?._meta?.antigravity?.tier?.name;
  return { kind: "signed-in", ...(typeof plan === "string" && plan.trim() ? { plan: plan.trim().slice(0, 60) } : {}) };
}

export function probeAntigravity(cli: string, env: NodeJS.ProcessEnv, timeoutMs = 45_000): Promise<AntigravityAuth> {
  return new Promise((resolve) => {
    let child: ChildProcess | undefined;
    let settled = false;
    const done = (result: AntigravityAuth) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
      resolve(result);
    };
    const timer = setTimeout(() => done({ kind: "problem" }), timeoutMs);
    try {
      child = spawnHidden(cli, ["acp"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...env, ...(process.platform === "win32" ? {} : { BROWSER: "true" }) },
      });
    } catch {
      done({ kind: "problem" });
      return;
    }
    const send = (value: unknown) => child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...(value as object) })}\n`);
    const onLine = (line: string) => {
      if (line.includes('"id":1') && !line.includes('"error"')) {
        try {
          if (JSON.parse(line).id === 1) send({ id: 2, method: "authenticate", params: { methodId: "oauth-personal" } });
        } catch {}
      }
      const result = readAuthLine(line);
      if (result) done(result);
    };
    child.stdin?.on("error", () => {});
    if (child.stdout) createInterface({ input: child.stdout }).on("line", onLine);
    // Its log lines are never shown: only the sign-in link is looked for.
    if (child.stderr) createInterface({ input: child.stderr }).on("line", (line) => { if (line.includes(AGY_AUTH_PREFIX)) done({ kind: "signed-out" }); });
    child.on("error", () => done({ kind: "problem" }));
    child.on("exit", () => done({ kind: "problem" }));
    send({ id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "kiwimake", version: "1" }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } });
  });
}
