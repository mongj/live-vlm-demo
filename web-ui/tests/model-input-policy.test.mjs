import assert from "node:assert/strict";
import test from "node:test";
import { typedInputPolicy } from "../src/lib/model-input-policy.mjs";

test("live MiniCPM video never enables a typed message that upstream would ignore", () => {
  const policy = typedInputPolicy("minicpm-o-4-5", true);
  assert.equal(policy.enabled, false);
  assert.match(policy.notice, /typed follow-ups/i);
  assert.match(policy.notice, /five minutes/i);
});

test("existing models retain typed input only during a live session", () => {
  for (const model of ["joyai-vl", "gemini-3-8-live", "mock"]) {
    assert.equal(typedInputPolicy(model, true).enabled, true);
    assert.equal(typedInputPolicy(model, false).enabled, false);
    assert.equal(typedInputPolicy(model, true).notice, null);
  }
});

test("MiniCPM limitations are visible before starting a session", () => {
  const policy = typedInputPolicy("minicpm-o-4-5", false);
  assert.equal(policy.enabled, false);
  assert.match(policy.notice, /instructions before/i);
});
