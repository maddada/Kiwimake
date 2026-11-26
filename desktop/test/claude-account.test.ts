// "Use another account": a new profile of Kiwimake's own, never the shared one (src/main/claude-account.ts).
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountSwitch, SHARED_ENTRIES, accountsRoot, claudeConfigDir, isInside, newProfile, otherProfiles, profileEnv, removeProfile, saveProfile, savedProfile, unlinkShared, useSavedProfile, type SignInLike } from "../src/main/claude-account.ts";
import type { ClaudeCheck } from "../src/shared/types.ts";

const unix = process.platform !== "win32";

/** A claude-swap style profile: its own sign-in, and projects/settings linked to ~/.claude. */
function sharedProfile(): { home: string; swap: string; root: string } {
  // The real path: on macOS the temp folder is a link (/var to /private/var), and profiles link to real paths.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kiwi-acct-")));
  const dotClaude = join(home, ".claude");
  mkdirSync(join(dotClaude, "projects", "-apps-tea"), { recursive: true });
  writeFileSync(join(dotClaude, "projects", "-apps-tea", "s1.jsonl"), "{}\n");
  writeFileSync(join(dotClaude, "settings.json"), '{"theme":"dark"}');
  mkdirSync(join(dotClaude, "skills"));
  const swap = join(home, "swap", "3-someone");
  mkdirSync(swap, { recursive: true });
  writeFileSync(join(swap, ".credentials.json"), "secret");
  writeFileSync(join(swap, ".claude.json"), '{"oauthAccount":{"accountUuid":"a"}}');
  symlinkSync(join(dotClaude, "projects"), join(swap, "projects"), "dir");
  symlinkSync(join(dotClaude, "settings.json"), join(swap, "settings.json"), "file");
  symlinkSync(join(dotClaude, "skills"), join(swap, "skills"), "dir");
  return { home, swap, root: accountsRoot(join(home, ".anyappagent")) };
}

describe("the Claude profile folders", () => {
  it("knows which folder Claude uses and which are Kiwimake's own", () => {
    expect(claudeConfigDir({}, "/home/u")).toBe(join("/home/u", ".claude"));
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: " /p " }, "/home/u")).toBe("/p");
    expect(isInside("/s/claude-accounts", "/s/claude-accounts/20261122-0900")).toBe(true);
    expect(isInside("/s/claude-accounts", "/s/claude-accounts")).toBe(false);
    expect(isInside("/s/claude-accounts", "/s/claude-accounts/../x")).toBe(false);
    expect(isInside("/s/claude-accounts", "/home/u/.claude")).toBe(false);
  });

  it.runIf(unix)("makes a new profile that shares chats and settings with the old one, but never its sign-in", () => {
    const { home, swap, root } = sharedProfile();
    const dir = newProfile(root, swap, new Date("2026-11-22T09:30:00Z"));
    expect(dir).toBe(join(root, "20261122-093000"));
    // Linked to the real folders, not to the swap profile's links (removing an old profile never breaks a new one).
    expect(readlinkSync(join(dir, "projects"))).toBe(join(home, ".claude", "projects"));
    expect(readlinkSync(join(dir, "settings.json"))).toBe(join(home, ".claude", "settings.json"));
    expect(existsSync(join(dir, "projects", "-apps-tea", "s1.jsonl"))).toBe(true);
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
    expect(existsSync(join(dir, ".claude.json"))).toBe(false);
    expect(existsSync(join(dir, "agents"))).toBe(false); // the old profile has none
    expect(SHARED_ENTRIES).not.toContain(".claude.json");
    expect(SHARED_ENTRIES).not.toContain(".credentials.json");
    // A second one in the same second gets its own folder.
    expect(newProfile(root, swap, new Date("2026-11-22T09:30:00Z"))).toBe(join(root, "20261122-093000-2"));
  });

  it.runIf(unix)("removes only its own folders, and never what they link to", () => {
    const { home, swap, root } = sharedProfile();
    const dir = newProfile(root, swap);
    writeFileSync(join(dir, ".credentials.json"), "new secret");
    expect(removeProfile(root, swap)).toBe(false);
    expect(existsSync(join(swap, ".credentials.json"))).toBe(true);
    expect(removeProfile(root, join(home, ".claude"))).toBe(false);
    expect(removeProfile(root, dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(home, ".claude", "projects", "-apps-tea", "s1.jsonl"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe('{"theme":"dark"}');
    expect(lstatSync(join(swap, "projects")).isSymbolicLink()).toBe(true);
  });

  it.runIf(unix)("drops the links before a sign-out, so it cannot write to a shared file", () => {
    const { home, swap, root } = sharedProfile();
    const dir = newProfile(root, swap);
    writeFileSync(join(dir, ".claude.json"), "{}");
    expect(unlinkShared(root, dir)).toBe(true);
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
    expect(existsSync(join(dir, ".claude.json"))).toBe(true);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
    expect(unlinkShared(root, swap)).toBe(false);
    expect(lstatSync(join(swap, "settings.json")).isSymbolicLink()).toBe(true);
  });

  it.runIf(unix)("uses the saved profile at every start, over KIWIMAKE_CLAUDE_CONFIG_DIR, while it has its sign-in", () => {
    const { swap, root } = sharedProfile();
    const env: Record<string, string | undefined> = { CLAUDE_CONFIG_DIR: swap };
    expect(useSavedProfile(env, root)).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe(swap);
    const dir = newProfile(root, swap);
    saveProfile(root, dir);
    expect(useSavedProfile(env, root)).toBeUndefined(); // not signed in there (no .claude.json)
    writeFileSync(join(dir, ".claude.json"), "{}");
    expect(useSavedProfile(env, root)).toBe(dir);
    expect(env.CLAUDE_CONFIG_DIR).toBe(dir);
    expect(() => saveProfile(root, swap)).toThrow();
    writeFileSync(join(root, "current.json"), JSON.stringify({ profile: "../../swap/3-someone" }));
    expect(savedProfile(root)).toBeUndefined();
  });

  it.runIf(unix)("lists the leftover folders, never the one in use or current.json", () => {
    const { swap, root } = sharedProfile();
    const a = newProfile(root, swap, new Date("2026-11-22T09:00:00Z"));
    const b = newProfile(root, swap, new Date("2026-11-22T10:00:00Z"));
    saveProfile(root, b);
    expect(otherProfiles(root, b)).toEqual([a]);
    expect(otherProfiles(join(root, "nope"), undefined)).toEqual([]);
  });

  it("signs in and checks with only the new folder, no API key or other provider", () => {
    const env = profileEnv({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/old", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_OAUTH_TOKEN: "t" }, "/new");
    expect(env).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/new" });
  });
});

class FakeSignIn extends EventEmitter implements SignInLike {
  url: string | undefined;
  running = false;
  error: string | undefined;
  started: NodeJS.ProcessEnv | undefined;
  codes: string[] = [];
  start(_cli: string, _engine: "claude", env: NodeJS.ProcessEnv): void {
    this.started = env;
    this.running = true;
  }
  submitCode(code: string): void {
    this.codes.push(code);
  }
  cancel(): void {
    this.running = false;
    this.emit("change");
    this.emit("done"); // like ClaudeSignIn: at once
  }
  /** The CLI ended by itself (signed in through the browser, or gave up). */
  exit(error?: string): void {
    this.running = false;
    this.error = error;
    this.emit("done");
  }
}

function setup(result: ClaudeCheck) {
  const { swap, root } = sharedProfile();
  const signIn = new FakeSignIn();
  const adopted: string[] = [];
  const asked: (string | undefined)[] = [];
  const sw = new AccountSwitch({
    root,
    current: () => swap,
    env: () => ({ CLAUDE_CONFIG_DIR: swap, ANTHROPIC_API_KEY: "k" }),
    signIn,
    status: async (e) => (asked.push(e.CLAUDE_CONFIG_DIR), result),
    adopt: (dir) => void adopted.push(dir),
    log: () => {},
  });
  return { swap, root, signIn, adopted, asked, sw };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe.runIf(unix)("Use another account", () => {
  it("signs in in a new folder, shows the link, and switches once it is a paid account", async () => {
    const t = setup({ state: "done", summary: "Signed in as b@example.com", email: "b@example.com", plan: "Max" });
    t.sw.start("/bin/claude");
    const dir = t.signIn.started!.CLAUDE_CONFIG_DIR!;
    expect(isInside(t.root, dir)).toBe(true);
    expect(t.signIn.started!.ANTHROPIC_API_KEY).toBeUndefined();
    expect(t.sw.state).toEqual({ phase: "signing-in" });
    t.signIn.url = "https://claude.ai/oauth/authorize?x";
    t.signIn.emit("change");
    expect(t.sw.state).toEqual({ phase: "signing-in", url: "https://claude.ai/oauth/authorize?x" });
    t.sw.submitCode("abc");
    expect(t.signIn.codes).toEqual(["abc"]);
    t.signIn.exit();
    await tick();
    expect(t.asked).toEqual([dir]);
    expect(t.adopted).toEqual([dir]);
    expect(t.sw.state).toEqual({ phase: "waiting", email: "b@example.com" });
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(t.swap, ".credentials.json"))).toBe(true); // the shared profile is untouched
    t.sw.settle("done");
    expect(t.sw.state?.phase).toBe("done");
    t.sw.cancel(); // OK closes the notice
    expect(t.sw.state).toBeUndefined();
    expect(existsSync(dir)).toBe(true);
  });

  it("changes nothing when cancelled, and removes the half-made folder", () => {
    const t = setup({ state: "needed", summary: "Claude is not signed in on this PC yet." });
    t.sw.start("/bin/claude");
    const dir = t.signIn.started!.CLAUDE_CONFIG_DIR!;
    t.sw.cancel();
    expect(t.sw.state).toBeUndefined();
    expect(t.signIn.running).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(t.adopted).toEqual([]);
  });

  it("refuses an account without a paid plan, and keeps the account in use", async () => {
    const t = setup({ state: "needed", summary: "Signed in, but this Claude account has no paid plan.", email: "free@example.com", plan: "Free" });
    t.sw.start("/bin/claude");
    const dir = t.signIn.started!.CLAUDE_CONFIG_DIR!;
    t.signIn.exit();
    await tick();
    expect(t.sw.state?.phase).toBe("failed");
    expect(t.sw.state?.error).toMatch(/no paid plan/);
    expect(t.adopted).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it("says so when the sign-in ends without signing in", async () => {
    const t = setup({ state: "needed", summary: "Claude is not signed in on this PC yet." });
    t.sw.start("/bin/claude");
    t.signIn.exit("The sign-in did not finish. Please try again.");
    await tick();
    expect(t.sw.state).toEqual({ phase: "failed", error: "The sign-in did not finish. Please try again." });
    expect(t.adopted).toEqual([]);
  });
});
