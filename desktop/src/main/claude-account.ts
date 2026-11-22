// "Use another account" in Settings: Kiwimake's Claude signs in as another Claude account.
//
// Kiwimake never signs out the Claude profile it uses now. That profile may be shared: the PC's own
// ~/.claude, or a claude-swap profile that Ghostex sessions (and the user's terminals) also run on
// (KIWIMAKE_CLAUDE_CONFIG_DIR picks one), and signing it out would sign all of them out. Instead the
// other account signs in into a new profile folder of Kiwimake's own,
// <state>/claude-accounts/<stamp>, the way Ghostex adds an account (its `account-login claude`
// signs in to a fresh profile and never touches the active one). Nothing changes until that sign-in
// worked: cancelling, closing the page or a free account leaves Kiwimake on its account.
//
// The new folder shares what is not the account with the profile Kiwimake used before, as links,
// the way claude-swap shares history between its profiles: `projects` (where Claude Code keeps every
// app's session, so each app's chat resumes with its memory on the new account), settings.json,
// skills, agents, commands, CLAUDE.md and history.jsonl. The sign-in itself (.credentials.json,
// .claude.json) stays in the folder. Once signed in, the desktop notes the folder in
// <state>/claude-accounts/current.json (it wins over KIWIMAKE_CLAUDE_CONFIG_DIR at every start,
// however Kiwimake is launched), points CLAUDE_CONFIG_DIR at it and restarts the companion when no app is
// working, so new chats run on the new account and its plan limits start fresh (server/src/usage.ts,
// claudeAccountKey). An older folder of Kiwimake's own is signed out and removed after that;
// folders outside <state>/claude-accounts are never signed out or removed.
import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import type { AccountSwitchState, ClaudeCheck } from "../shared/types.ts";

type Env = Record<string, string | undefined>;

/** Not the account: shared with the profile Kiwimake used before, so chats resume and settings stay. */
export const SHARED_ENTRIES = ["projects", "settings.json", "skills", "agents", "commands", "CLAUDE.md", "history.jsonl"];

/**
 * Removed for the sign-in and the checks of the new folder: with one of them set, Claude would use
 * that key or provider instead of the account signed in there (Ghostex's LoginProfile does the same).
 */
const OTHER_AUTH = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

/** The Claude profile folder Claude uses with this environment. */
export function claudeConfigDir(env: Env, home = homedir()): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
}

/** Where Kiwimake keeps the profiles of its own. */
export function accountsRoot(stateDir: string): string {
  return join(stateDir, "claude-accounts");
}

/** True when `dir` is a folder inside `root` (never `root` itself). */
export function isInside(root: string, dir: string): boolean {
  const rel = relative(resolve(root), resolve(dir));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

const CURRENT = "current.json";

/** The profile "Use another account" signed in, when there is one and it still has its sign-in. */
export function savedProfile(root: string): string | undefined {
  try {
    const name = (JSON.parse(readFileSync(join(root, CURRENT), "utf8")) as { profile?: unknown }).profile;
    if (typeof name !== "string" || !name || name.includes("/") || name.includes("\\")) return undefined;
    const dir = join(root, name);
    return isInside(root, dir) && existsSync(join(dir, ".claude.json")) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** Notes `dir` (a folder in `root`) as the profile Kiwimake uses from now on. */
export function saveProfile(root: string, dir: string): void {
  if (!isInside(root, dir)) throw new Error("Not one of Kiwimake's own Claude profiles.");
  writeFileSync(join(root, CURRENT), `${JSON.stringify({ profile: relative(root, dir) }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * At start, after leaveClaudeSession: the profile signed in with "Use another account" wins over
 * KIWIMAKE_CLAUDE_CONFIG_DIR and the shell's CLAUDE_CONFIG_DIR. Returns it, or undefined when
 * there is none (or it is gone), and then nothing changes.
 */
export function useSavedProfile(env: Env, root: string): string | undefined {
  const dir = savedProfile(root);
  if (dir) env.CLAUDE_CONFIG_DIR = dir;
  return dir;
}

/** The environment for Claude in `dir`: that folder, and no other key or provider. */
export function profileEnv(env: Env, dir: string): Env {
  const out: Env = { ...env, CLAUDE_CONFIG_DIR: dir };
  for (const key of OTHER_AUTH) delete out[key];
  return out;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

/**
 * A new, empty profile folder in `root` whose SHARED_ENTRIES link to those of `shareFrom` (to the
 * real files: a link in shareFrom is followed, so removing an older folder never breaks the new
 * one). Entries shareFrom lacks are left out. Windows: folders become junctions, and a file that
 * cannot be linked is copied.
 */
export function newProfile(root: string, shareFrom: string, now = new Date(), platform: NodeJS.Platform = process.platform): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let dir = join(root, stamp(now));
  for (let n = 2; existsSync(dir); n++) dir = join(root, `${stamp(now)}-${n}`);
  mkdirSync(dir, { mode: 0o700 });
  for (const name of SHARED_ENTRIES) {
    let target: string;
    try {
      target = realpathSync(join(shareFrom, name));
    } catch {
      continue;
    }
    if (isInside(dir, target) || resolve(target) === resolve(dir)) continue;
    const folder = statSync(target).isDirectory();
    try {
      symlinkSync(target, join(dir, name), folder ? (platform === "win32" ? "junction" : "dir") : "file");
    } catch {
      if (!folder) copyFileSync(target, join(dir, name));
    }
  }
  return dir;
}

/**
 * Removes a profile folder of Kiwimake's own. Links in it are removed, never followed, so the shared
 * projects, settings and skills stay. Anything outside `root` is refused.
 */
export function removeProfile(root: string, dir: string): boolean {
  if (!unlinkShared(root, dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Removes the links to the shared entries from a profile folder of Kiwimake's own (before signing
 * it out, so nothing the sign-out writes can reach a shared file). Anything outside `root` is refused.
 */
export function unlinkShared(root: string, dir: string): boolean {
  if (!isInside(root, dir) || !existsSync(dir)) return false;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (lstatSync(path).isSymbolicLink()) rmSync(path, { force: true });
  }
  return true;
}

/** Kiwimake's own profile folders other than `keep` (abandoned sign-ins, the account it used before). */
export function otherProfiles(root: string, keep: string | undefined): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names.map((n) => join(root, n)).filter((p) => (!keep || resolve(p) !== resolve(keep)) && lstatSync(p).isDirectory() && !lstatSync(p).isSymbolicLink());
}

/** What Settings shows while another account signs in. */
export type SwitchState = AccountSwitchState;

/** The part of ClaudeSignIn the switch uses (signin.ts). */
export interface SignInLike extends EventEmitter {
  url: string | undefined;
  running: boolean;
  error: string | undefined;
  start(cli: string, engine: "claude", env: NodeJS.ProcessEnv): void;
  submitCode(code: string): void;
  cancel(): void;
}

export interface SwitchDeps {
  root: string;
  /** The profile Kiwimake's Claude uses now (it is shared into the new one). */
  current: () => string;
  env: () => Env;
  signIn: SignInLike;
  /** `claude auth status` for this environment (detectEngine). */
  status: (env: Env) => Promise<ClaudeCheck>;
  /** Make Kiwimake use `dir` from now on (save it, point CLAUDE_CONFIG_DIR at it, restart the companion when idle). */
  adopt: (dir: string, email: string | undefined) => Promise<void> | void;
  log: (line: string) => void;
  now?: () => Date;
}

/**
 * One "Use another account": a new profile, the sign-in in it, a check that it is a paid Claude
 * plan, then adopt. Emits "change". Cancel, a failure or a free account remove the new folder.
 */
export class AccountSwitch extends EventEmitter {
  state: SwitchState | undefined;
  private dir: string | undefined;
  private poll: NodeJS.Timeout | undefined;
  private checking = false;

  constructor(private readonly deps: SwitchDeps) {
    super();
    deps.signIn.on("change", () => {
      if (this.state?.phase === "signing-in" && deps.signIn.url && deps.signIn.url !== this.state.url) this.set({ ...this.state, url: deps.signIn.url });
    });
    deps.signIn.on("done", () => {
      if (this.state?.phase !== "signing-in") return;
      if (deps.signIn.error) this.fail(deps.signIn.error);
      else void this.check(true);
    });
  }

  get active(): boolean {
    return this.state?.phase === "signing-in" || this.state?.phase === "checking";
  }

  private set(state: SwitchState | undefined): void {
    this.state = state;
    this.emit("change");
  }

  start(cli: string): void {
    if (this.active) return;
    const from = this.deps.current();
    this.dir = newProfile(this.deps.root, from, this.deps.now?.() ?? new Date());
    this.deps.log(`[claude] another account: signing in to a new profile of Kiwimake's own (${this.dir})`);
    this.set({ phase: "signing-in" });
    this.deps.signIn.start(cli, "claude", profileEnv(this.deps.env(), this.dir) as NodeJS.ProcessEnv);
    // Finishing in the browser ends the sign-in by itself; look every 3 s like the setup step does.
    this.poll = setInterval(() => void this.check(false), 3_000);
  }

  submitCode(code: string): void {
    if (this.state?.phase === "signing-in") this.deps.signIn.submitCode(code);
  }

  /** Stops a sign-in that is still running; nothing changes. Also closes a finished or failed notice. */
  cancel(): void {
    const running = this.active;
    this.stopPoll();
    // The state goes first: stopping the sign-in emits "done" at once.
    this.state = undefined;
    if (running) {
      this.deps.signIn.cancel();
      this.discard();
      this.deps.log("[claude] another account: cancelled, Kiwimake stays on its account");
    }
    this.emit("change");
  }

  /** The adopted switch is waiting for apps to finish, or is done. */
  settle(phase: "waiting" | "done"): void {
    if (this.state && (this.state.phase === "waiting" || this.state.phase === "done")) this.set({ ...this.state, phase });
  }

  private stopPoll(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  private discard(): void {
    if (this.dir) removeProfile(this.deps.root, this.dir);
    this.dir = undefined;
  }

  private fail(error: string): void {
    this.stopPoll();
    // The state goes first: stopping the sign-in emits "done" at once.
    this.state = { phase: "failed", error };
    this.deps.signIn.cancel();
    this.discard();
    this.deps.log(`[claude] another account: not switched (${error})`);
    this.emit("change");
  }

  /** `final`: the sign-in ended by itself, so a missing sign-in is a failure, not "not yet". */
  private async check(final: boolean): Promise<void> {
    const dir = this.dir;
    if (!dir || this.checking || this.state?.phase !== "signing-in") return;
    this.checking = true;
    try {
      const result = await this.deps.status(profileEnv(this.deps.env(), dir));
      if (this.dir !== dir || this.state?.phase !== "signing-in") return;
      if (result.state !== "done" && result.email === undefined && !final) return; // not signed in yet
      if (result.state !== "done") {
        this.fail(result.email ? "This Claude account has no paid plan. Claude Pro or Max is needed, so Kiwimake stays on its account." : "The sign-in did not finish. Kiwimake stays on its account.");
        return;
      }
      this.stopPoll();
      this.set({ phase: "checking", email: result.email });
      this.deps.signIn.cancel();
      this.dir = undefined;
      await this.deps.adopt(dir, result.email);
      this.set({ phase: "waiting", email: result.email });
    } catch (error) {
      this.fail((error as Error).message);
    } finally {
      this.checking = false;
    }
  }
}
