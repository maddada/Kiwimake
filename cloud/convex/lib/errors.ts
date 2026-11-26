// Error reporting to Sentry on Convex Starter (docs/CLOUD.md section 3, "Running on Convex Starter"). Convex's
// own exception reporting "is only available to Pro users", so failures we catch in HTTP actions
// and actions are sent to Sentry's envelope endpoint ourselves, with fetch (no SDK): the message,
// the stack, where it happened and a few tags. Never request bodies, headers, keys or tokens: the
// text is scrubbed of anything shaped like a secret first. Without SENTRY_DSN nothing is sent.
// Queries and mutations cannot fetch: they schedule internal.errors.report when they catch one.

export interface SentryDsn {
  url: string;
  publicKey: string;
  dsn: string;
}

/** https://<publicKey>@<host>/<projectId> to the envelope URL and key. */
export function parseDsn(dsn: string | undefined): SentryDsn | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+|\/+$/g, '');
    if (u.protocol !== 'https:' || !u.username || !/^\d+$/.test(projectId)) return null;
    return { url: `https://${u.host}/api/${projectId}/envelope/`, publicKey: u.username, dsn };
  } catch {
    return null;
  }
}

const SECRET_SHAPES: RegExp[] = [
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+/g, // Stripe
  /\bwhsec_[A-Za-z0-9+/=]+/g,
  /\bsk-(?:ant|or|proj)-[A-Za-z0-9_-]+/g, // Anthropic, OpenRouter, OpenAI
  /\bsk-[A-Za-z0-9]{20,}/g, // DeepSeek and others
  /\bgh[opsur]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]+/g,
  /\bibk_[A-Za-z0-9_-]+|\bibsec_[A-Za-z0-9_-]+/g, // Instabox
  /\bre_[A-Za-z0-9_]{16,}/g, // Resend
  /\bkpc_[A-Za-z0-9_-]+/g, // PC links
  /\b(?:prod|dev|preview|project):[a-z0-9-]+\|[A-Za-z0-9+/=_-]+/g, // Convex deploy keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWTs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // email addresses
];

export function scrub(text: string, max = 2000): string {
  let out = String(text ?? '');
  for (const re of SECRET_SHAPES) out = out.replace(re, '[redacted]');
  return out.slice(0, max);
}

function hex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ErrorReport {
  where: string;
  message: string;
  type?: string;
  stack?: string;
  level?: 'error' | 'warning';
  tags?: Record<string, string>;
}

/** Sentry's envelope: a header line, an item header line, the event. */
export function envelope(d: SentryDsn, r: ErrorReport, now = new Date()): string {
  const eventId = hex(16);
  const tags: Record<string, string> = { where: scrub(r.where, 200) };
  for (const [k, v] of Object.entries(r.tags ?? {})) if (/^[a-z][a-z0-9_.]{0,31}$/.test(k)) tags[k] = scrub(String(v), 200);
  const event = {
    event_id: eventId,
    timestamp: now.toISOString(),
    platform: 'javascript',
    level: r.level ?? 'error',
    logger: 'convex',
    server_name: 'convex',
    environment: process.env.SENTRY_ENVIRONMENT || 'production',
    ...(process.env.SENTRY_RELEASE ? { release: process.env.SENTRY_RELEASE } : {}),
    transaction: tags.where,
    tags,
    exception: { values: [{ type: scrub(r.type ?? 'Error', 100), value: scrub(r.message) }] },
    ...(r.stack ? { extra: { stack: scrub(r.stack, 4000) } } : {}),
  };
  return [JSON.stringify({ event_id: eventId, dsn: d.dsn, sent_at: now.toISOString() }), JSON.stringify({ type: 'event' }), JSON.stringify(event)].join('\n');
}

export function reportOf(e: unknown, where: string, tags?: Record<string, string>, level?: 'error' | 'warning'): ErrorReport {
  const err = e instanceof Error ? e : new Error(String(e));
  return { where, message: err.message, type: err.name, ...(err.stack ? { stack: err.stack } : {}), ...(tags ? { tags } : {}), ...(level ? { level } : {}) };
}

/**
 * Sends one report (actions and HTTP actions only). Never throws and never waits more than 3 s:
 * a reporting problem must not turn into a second failure.
 */
export async function sendReport(r: ErrorReport): Promise<boolean> {
  const d = parseDsn(process.env.SENTRY_DSN);
  if (!d) return false;
  try {
    const res = await fetch(d.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${d.publicKey}, sentry_client=kiwimake-convex/1` },
      body: envelope(d, r),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** console.error as before, plus the report to Sentry. */
export async function reportError(e: unknown, where: string, tags?: Record<string, string>): Promise<void> {
  console.error(`${where}:`, e instanceof Error ? e.message : String(e));
  await sendReport(reportOf(e, where, tags));
}
