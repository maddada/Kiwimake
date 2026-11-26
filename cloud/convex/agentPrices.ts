// What the cloud's OpenCode agent costs us per model, for billing.ts (docs/CLOUD.md section 5), kept
// apart from config.ts's MODEL_PRICES so the router models can change on their own. Micros per
// million tokens: in, out, cache write, cache read. A change is never priced under its cost:
//   - OpenRouter routes a model to any of its hosts, each at its own price, and charges 5.5% when
//     credits are bought: each figure is the dearest host's (https://openrouter.ai/api/v1/models/<id>/endpoints,
//     26 Nov 2026) times 1.055, rounded up. Cache writes are priced as input.
//   - TheRouter publishes $0.7128 / $2.14 for V4 Pro and $0.162 / $0.648 for Flash
//     (https://therouter.ai/models/), but its V4 Pro page still says "TheRouter continues to price at
//     $2.50/$5.00" and no cache price is published: V4 Pro at $2.50 / $5.00, and cache reads at the
//     input price, until a real call shows what it bills.
// A model not listed here (or in MODEL_PRICES) is priced as Opus, which is dearer than all of these.

const perM = (dollars: number) => Math.ceil(dollars * 1_000_000);
const withFee = (dollars: number) => perM(dollars * 1.055);

export const AGENT_MODEL_PRICES: Record<string, [number, number, number, number]> = {
  // OpenRouter, DeepSeek V4 Pro 0813: dearest host Parasail fast ($1.98 / $5.94), cache read Wafer mxfp4 ($0.284).
  'openrouter/deepseek/deepseek-v4-pro-0813': [withFee(1.98), withFee(5.94), withFee(1.98), withFee(0.284)],
  // OpenRouter, DeepSeek V4.1 Flash 1017: dearest hosts at $0.60 / $2.40, cache read $0.014.
  'openrouter/deepseek/deepseek-v4.1-flash-1017': [withFee(0.6), withFee(2.4), withFee(0.6), withFee(0.014)],
  // TheRouter (see above).
  'therouter/deepseek/deepseek-v4-pro': [perM(2.5), perM(5), perM(2.5), perM(2.5)],
  'therouter/deepseek/deepseek-v4-flash': [perM(0.162), perM(0.648), perM(0.162), perM(0.162)],
};
