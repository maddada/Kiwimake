// What the phone says when a cloud call fails (src/lib/cloudError.ts), for a production and a dev
// deployment. Run: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLOUD_GENERIC, CLOUD_OFFLINE, CODE_FAILED, cloudMessage, needsSignIn } from "../src/lib/cloudError.ts";

/** Shaped like the Convex client's ConvexError: the sentence is in `data`. */
function convexError(data, message = "[Request ID: 3f2a] Server Error") {
  return Object.assign(new Error(message), { name: "ConvexError", data });
}

test("a refusal for people shows its sentence, in production too", () => {
  const e = convexError("This change needs about 5.2 credits and you have 2.4. Get extra credit or a plan to go on.");
  assert.equal(cloudMessage(e), "This change needs about 5.2 credits and you have 2.4. Get extra credit or a plan to go on.");
  assert.equal(needsSignIn(convexError("Sign in first.")), true);
  assert.equal(needsSignIn(e), false);
});

test("a hidden production error becomes a plain sentence, or the caller's fallback", () => {
  const hidden = new Error("[CONVEX M(chat:send)] [Request ID: 3f2a] Server Error");
  assert.equal(cloudMessage(hidden), CLOUD_GENERIC);
  assert.equal(cloudMessage(new Error("[Request ID: 9b] Server Error"), CODE_FAILED), CODE_FAILED);
  assert.ok(!cloudMessage(hidden).includes("Request ID"));
});

test("a dev deployment's text is cut down to its sentence", () => {
  const dev = new Error("[CONVEX M(chat:send)] [Request ID: 1] Server Error\nUncaught Error: Write a message first.\n    at handler (../convex/chat.ts:100:5)");
  assert.equal(cloudMessage(dev), "Write a message first.");
  const devConvex = new Error("[CONVEX M(chat:send)] [Request ID: 1] Server Error\nUncaught ConvexError: Write a message first.\n    at handler");
  assert.equal(cloudMessage(devConvex), "Write a message first.");
});

test("a wrong email code and a dead network say what to do", () => {
  assert.equal(cloudMessage(new Error("[CONVEX A(auth:signIn)] Uncaught Error: Could not verify code")), CODE_FAILED);
  assert.equal(cloudMessage(new TypeError("Network request failed")), CLOUD_OFFLINE);
  assert.equal(cloudMessage("plain words"), "plain words");
});
