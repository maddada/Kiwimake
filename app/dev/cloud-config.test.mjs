// Which Kiwimake Cloud a build talks to (app.config.js cloudFor, read by src/lib/cloud.ts).
// Run: npm test
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { cloudFor, CLOUDS } = require("../app.config.js");

test("a release build always uses production, and refuses anything else", () => {
  assert.deepEqual(cloudFor(true, {}), { name: "prod", url: CLOUDS.prod });
  assert.deepEqual(cloudFor(true, { KIWIMAKE_CLOUD: "prod" }), { name: "prod", url: CLOUDS.prod });
  assert.deepEqual(cloudFor(true, { EXPO_PUBLIC_CONVEX_URL: `${CLOUDS.prod}/` }), { name: "prod", url: CLOUDS.prod });
  assert.throws(() => cloudFor(true, { KIWIMAKE_CLOUD: "dev" }), /always uses the production cloud/);
  assert.throws(() => cloudFor(true, { EXPO_PUBLIC_CONVEX_URL: CLOUDS.dev }), /always uses the production cloud/);
  assert.equal(CLOUDS.prod, "https://utmost-deer-505.convex.cloud");
});

test("other builds: no cloud unless asked; dev, prod or any deployment when asked", () => {
  assert.deepEqual(cloudFor(false, {}), { name: "off", url: "" });
  assert.deepEqual(cloudFor(false, { KIWIMAKE_CLOUD: "dev" }), { name: "dev", url: CLOUDS.dev });
  assert.deepEqual(cloudFor(false, { KIWIMAKE_CLOUD: "prod" }), { name: "prod", url: CLOUDS.prod });
  assert.deepEqual(cloudFor(false, { KIWIMAKE_CLOUD: "off", EXPO_PUBLIC_CONVEX_URL: CLOUDS.dev }), { name: "off", url: "" });
  assert.deepEqual(cloudFor(false, { EXPO_PUBLIC_CONVEX_URL: CLOUDS.dev }), { name: "dev", url: CLOUDS.dev });
  assert.deepEqual(cloudFor(false, { EXPO_PUBLIC_CONVEX_URL: "https://happy-otter-1.convex.cloud" }), { name: "custom", url: "https://happy-otter-1.convex.cloud" });
  assert.throws(() => cloudFor(false, { KIWIMAKE_CLOUD: "staging" }), /prod, dev or off/);
});
