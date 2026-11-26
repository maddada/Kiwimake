// What a failed cloud call says to the person (no imports, so dev/cloud-error.test.mjs runs it in
// plain Node). The cloud sends a refusal meant for people as a ConvexError: its sentence is in
// `error.data`, in production too. Any other error's text is hidden by a production deployment
// ("[Request ID: ...] Server Error"); a dev deployment shows "... Uncaught Error: <text>\n at ...".

export const CLOUD_GENERIC = "Something went wrong in Kiwimake's cloud. Try again.";
export const CLOUD_OFFLINE = "Can't reach Kiwimake's cloud. Check the phone's internet, then try again.";
/** A wrong or old email code: Convex Auth's own error, which production hides. */
export const CODE_FAILED = "That code did not work. Check it, or send a new one.";

/** The sentence to show for a failed cloud call; `fallback` when the cloud hid the reason. */
export function cloudMessage(e: unknown, fallback: string = CLOUD_GENERIC): string {
  const data = e !== null && typeof e === "object" && "data" in e ? (e as { data: unknown }).data : undefined;
  if (typeof data === "string" && data.trim()) return data.trim().slice(0, 300);
  const raw = e instanceof Error ? e.message : String(e);
  if (/fetch failed|Network request failed|WebSocket/i.test(raw)) return CLOUD_OFFLINE;
  const m = /Uncaught (?:ConvexError: |Error: )?([^\n]+)/.exec(raw);
  const text = (m?.[1] ?? raw)
    .replace(/\s+at .*$/, "")
    .replace(/^\[CONVEX [^\]]*\]\s*/, "")
    .replace(/^\[Request ID: [^\]]*\]\s*/, "")
    .trim();
  if (!text || /^Server Error$/i.test(text)) return fallback;
  if (/Could not verify code/i.test(text)) return CODE_FAILED;
  return text.slice(0, 300);
}

/** True when the cloud refused because the person is not signed in. */
export function needsSignIn(e: unknown): boolean {
  return /^Sign in first/.test(cloudMessage(e));
}
