// The engines by name, with no Node imports, so the desktop's renderer can use them too.
// shared/engines.mts re-exports all of it.
export type Engine = "claude" | "codex" | "antigravity";
export const ENGINES: readonly Engine[] = ["claude", "codex", "antigravity"];
export const engineName = (engine: Engine): string => engine === "codex" ? "Codex" : engine === "antigravity" ? "Antigravity" : "Claude";
export const CODEX_MODEL = "gpt-6.2-sol";
/** When the signed-in ChatGPT plan refuses CODEX_MODEL (a free plan), the companion uses this one (server/src/acp/codex-model.ts). */
export const CODEX_FALLBACK_MODEL = "gpt-6-luna";
export const CODEX_EFFORT = "high";
/**
 * Antigravity (Google's `agy` CLI) runs over ACP as `agy acp`. Its 1.5 runtime offers the model
 * and the thinking level as two session config options: "gemini-4-neon" at "high" is what
 * `agy models` lists as gemini-4-neon-high (server/src/acp/antigravity.ts).
 */
export const ANTIGRAVITY_MODEL = "gemini-4-neon";
export const ANTIGRAVITY_EFFORT = "high";
export const isEngine = (value: unknown): value is Engine => value === "claude" || value === "codex" || value === "antigravity";
