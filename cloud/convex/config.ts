// Kiwimake Cloud's prices, allowances and timings in one place (docs/CLOUD.md, sections 2 and 5),
// so a price change is one edit. Money is in micros (millionths of a dollar), credits in
// millicredits (thousandths of a credit): integers only, never floats.

/** What one credit costs us, never shown to anyone (section 2, "Credits per change"). */
export const CREDIT_COST_MICROS = 200_000;

export type PlanId = 'free' | 'starter' | 'pro' | 'max' | 'ownKey';
export type Interval = 'month' | 'year';

export interface Plan {
  id: PlanId;
  name: string;
  /** Price in US cents per interval. */
  cents: { month: number; year: number };
  /** Credits given every month (yearly plans too: monthly, not all at once). */
  monthlyMillicredits: number;
}

export const PLANS: Record<PlanId, Plan> = {
  free: { id: 'free', name: 'Free', cents: { month: 0, year: 0 }, monthlyMillicredits: 0 },
  starter: { id: 'starter', name: 'Starter', cents: { month: 1200, year: 12000 }, monthlyMillicredits: 30_000 },
  pro: { id: 'pro', name: 'Pro', cents: { month: 2500, year: 25000 }, monthlyMillicredits: 70_000 },
  max: { id: 'max', name: 'Max', cents: { month: 6000, year: 60000 }, monthlyMillicredits: 180_000 },
  ownKey: { id: 'ownKey', name: 'Own key', cents: { month: 600, year: 6000 }, monthlyMillicredits: 0 },
};

/** Extra credit: $10 for 20 credits, valid 12 months, with or without a plan. */
export const EXTRA_PACK = { cents: 1000, millicredits: 20_000, validDays: 365 };
/** Free credit every month, given on the first cloud change of the month. */
export const FREE_MONTHLY_MILLICREDITS = 3_000;
/** A person's first new app uses at most this much. */
export const FIRST_APP_CAP_MILLICREDITS = 3_000;
/** A running change may go this far past the balance before the runner stops it. */
export const OVERDRAFT_MILLICREDITS = 500;
/** Own key plan: fair use box hours a month, then half a credit per box hour. */
export const OWN_KEY_FAIR_USE_SECONDS = 30 * 3600;
export const OWN_KEY_EXTRA_MILLICREDITS_PER_HOUR = 500;

/**
 * List prices per million tokens, micros: in, out, cache write, cache read (section 7). Keys are
 * the model ids the runner's usage events carry: Anthropic's, or opencode's "<provider>/<model>".
 * DeepSeek (https://api-docs.deepseek.com/quick_start/pricing, 26 Nov 2026) bills half price
 * off-peak; we always price at its peak rate (01:00 to 04:00 and 06:00 to 10:00 UTC on weekdays),
 * so a change is never priced under its cost. DeepSeek has no cache write price: a cache miss is
 * the input price, so cache writes are priced as input. OpenCode Go's DeepSeek ids are priced the
 * same (Go is for the owner's own tests only, docs/CLOUD.md section 3, "OpenCode, a second cloud engine").
 */
const DEEPSEEK_V4_PRO: [number, number, number, number] = [1_320_000, 3_960_000, 1_320_000, 44_000];
const DEEPSEEK_FLASH: [number, number, number, number] = [300_000, 1_200_000, 300_000, 6_000];
export const MODEL_PRICES: Record<string, [number, number, number, number]> = {
  'claude-opus-5-5': [4_000_000, 20_000_000, 5_000_000, 200_000],
  'claude-sonnet-5-5': [2_000_000, 10_000_000, 2_500_000, 100_000],
  'deepseek/deepseek-v4-pro': DEEPSEEK_V4_PRO,
  'deepseek/deepseek-flash': DEEPSEEK_FLASH,
  'opencode-go/deepseek-v4-pro': DEEPSEEK_V4_PRO,
  'opencode-go/deepseek-v4.1-flash': DEEPSEEK_FLASH,
};

/**
 * The cloud's engine (docs/CLOUD.md section 3, "OpenCode, a second cloud engine"), one choice for the deployment, set
 * with Convex environment variables, never in code: CLOUD_AGENT_ENGINE "claude" (the default) or
 * "opencode"; CLOUD_OPENCODE_PROVIDER, CLOUD_OPENCODE_MODEL and CLOUD_OPENCODE_SIMPLE_MODEL
 * override the opencode defaults (server/src/cloud-settings.ts reads the same values on the box).
 * The Own key plan always runs Claude: the person's key is an Anthropic key.
 */
export type AgentEngine = 'claude' | 'opencode';
export interface OpencodeProviderSpec {
  id: string;
  apiKeyEnv: string;
  npm?: string;
  baseURL?: string;
  name?: string;
}
export interface AgentChoice {
  engine: AgentEngine;
  /** The box's proxy Secrets: the environment variable names the AI key reaches the agent under. */
  keyEnv: string;
  /** What the runner puts in its environment before the companion's work loop starts. */
  env: Record<string, string>;
}

export const OPENCODE_DEFAULT_PROVIDER: OpencodeProviderSpec = { id: 'deepseek', apiKeyEnv: 'DEEPSEEK_API_KEY' };
export const OPENCODE_DEFAULT_MODEL = 'deepseek/deepseek-v4-pro';
export const OPENCODE_DEFAULT_SIMPLE_MODEL = 'deepseek/deepseek-flash';
/** Where the runner keeps each opencode session's config: a folder the agent can read too (the kiwi group). */
export const OPENCODE_CONFIG_DIR = '/data/apps/.opencode';

export function agentChoice(aiMode: string | undefined, env: Record<string, string | undefined> = process.env): AgentChoice {
  const engine = env.CLOUD_AGENT_ENGINE === 'opencode' && aiMode !== 'ownAnthropic' ? 'opencode' : 'claude';
  if (engine === 'claude') return { engine, keyEnv: 'ANTHROPIC_API_KEY', env: { ANYAPP_CLOUD_ENGINE: 'claude' } };
  let provider = OPENCODE_DEFAULT_PROVIDER;
  if (env.CLOUD_OPENCODE_PROVIDER) {
    const p = JSON.parse(env.CLOUD_OPENCODE_PROVIDER) as Partial<OpencodeProviderSpec>;
    if (typeof p?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(p.id) || typeof p.apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(p.apiKeyEnv)) {
      throw new Error('CLOUD_OPENCODE_PROVIDER must be JSON like {"id":"deepseek","apiKeyEnv":"DEEPSEEK_API_KEY"}');
    }
    provider = p as OpencodeProviderSpec;
  }
  const isDefault = provider.id === OPENCODE_DEFAULT_PROVIDER.id;
  const model = env.CLOUD_OPENCODE_MODEL || (isDefault ? OPENCODE_DEFAULT_MODEL : '');
  const simple = env.CLOUD_OPENCODE_SIMPLE_MODEL || (isDefault && !env.CLOUD_OPENCODE_MODEL ? OPENCODE_DEFAULT_SIMPLE_MODEL : model);
  for (const m of [model, simple]) {
    if (!m.startsWith(`${provider.id}/`) || m.length <= provider.id.length + 1) throw new Error(`The opencode model must be "${provider.id}/<model>", not "${m}"`);
  }
  return {
    engine,
    keyEnv: provider.apiKeyEnv,
    env: {
      ANYAPP_CLOUD_ENGINE: 'opencode',
      ANYAPP_OPENCODE_PROVIDER: JSON.stringify(provider),
      ANYAPP_OPENCODE_MODEL: model,
      ANYAPP_OPENCODE_SIMPLE_MODEL: simple,
      ANYAPP_OPENCODE_CONFIG_DIR: OPENCODE_CONFIG_DIR,
    },
  };
}

/** The box's proxy Secrets: BOX_PROXY_SECRETS when set (comma separated), else the engine's key. */
export function boxSecrets(choice: AgentChoice, env: Record<string, string | undefined> = process.env): string[] {
  return (env.BOX_PROXY_SECRETS ?? choice.keyEnv).split(',').map((s) => s.trim()).filter(Boolean);
}
/** Instabox 4 vCPU / 8 GiB: 4 x $0.004 + 8 x $0.00225 an hour, in micros per running second. */
export const BOX_MICROS_PER_HOUR = 34_000;

/** Box lifecycle (section 3, "One box per thread"). */
export const BOX = {
  /** Pause this long after the last work. */
  pauseAfterMs: 5 * 60_000,
  /** Snapshot and delete after this long paused. */
  snapshotAfterMs: 60 * 60_000,
  /** A snapshot unused this long is deleted; the next message clones from GitHub. */
  snapshotTtlMs: 30 * 24 * 3600_000,
  /** The image every box starts from (the spike's snapshot); BOX_IMAGE_SNAPSHOT on the deployment overrides it (anyapp-box-v2 has opencode). */
  imageSnapshot: 'anyapp-box-v1',
  /** A person may have this many boxes not deleted. */
  maxPerUser: 5,
};

/**
 * Deleting and downloading (docs/CLOUD.md section 6, "Deleting an app, an account, and downloading
 * your data"). Each is one constant, so the policy is one edit.
 */
export const PRIVACY = {
  /** A deleted cloud app can be brought back this long; then its chat, files and builds are deleted for good. */
  appUndoMinutes: 10,
  /** Signing keys of deleted apps and deleted accounts stay sealed this long (a person who changes their mind can write to us), then are deleted. */
  keyGraceDays: 30,
  /** Each app keeps the files (APKs, quick updates) of its newest builds only. */
  keepBuilds: 3,
  /** A download link (my data, signing keys) works this long; then the file is deleted. */
  downloadMinutes: 30,
};

/** Package prefixes: a cloud-born app and a PC-born app (both accepted; the name is the app's for life). */
export const CLOUD_PACKAGE_PREFIX = 'com.anyappcloud.';
export const PC_PACKAGE_PREFIX = 'com.anyapp.';

/** Turns our cost into millicredits (rounded up to whole millicredits). */
export function microsToMillicredits(micros: number): number {
  return Math.ceil((micros * 1000) / CREDIT_COST_MICROS);
}

/** Rounds a change's total up to a tenth of a credit (section 5). */
export function roundUpToTenth(millicredits: number): number {
  return Math.ceil(millicredits / 100) * 100;
}
