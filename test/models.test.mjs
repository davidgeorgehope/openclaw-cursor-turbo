import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyThinkingLevel,
  parseCursorModelId,
  toAcpModelId,
  toCursorModelId,
} from "../lib/models.mjs";
import { toSdkModel } from "../lib/sdk-transport.mjs";

const CATALOG = [
  { modelId: "default[]", name: "Auto" },
  { modelId: "grok-4.5[effort=high,fast=true]", name: "grok-4.5" },
  { modelId: "composer-2.5[fast=true]", name: "composer-2.5" },
  { modelId: "claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]", name: "claude-opus-4-8" },
  { modelId: "gemini-3.5-flash[]", name: "gemini-3.5-flash" },
];

test("parseCursorModelId splits effort/fast/thinking suffixes", () => {
  assert.deepEqual(parseCursorModelId("grok-4.5-fast-xhigh"), {
    base: "grok-4.5",
    effort: "xhigh",
    fast: true,
    thinking: false,
  });
  assert.deepEqual(parseCursorModelId("claude-opus-4-8-thinking-high"), {
    base: "claude-opus-4-8",
    effort: "high",
    fast: false,
    thinking: true,
  });
  assert.deepEqual(parseCursorModelId("composer-2.5"), {
    base: "composer-2.5",
    effort: undefined,
    fast: false,
    thinking: false,
  });
});

test("parseCursorModelId passes through bracketed raw ids", () => {
  assert.deepEqual(parseCursorModelId("grok-4.5[effort=low]"), { raw: "grok-4.5[effort=low]" });
});

test("toAcpModelId collapses variants to the advertised modelId", () => {
  // set_model only accepts advertised ids, so variant suffixes map to the
  // catalog's default variant of the same base model.
  assert.equal(
    toAcpModelId(parseCursorModelId("grok-4.5-fast-xhigh"), CATALOG),
    "grok-4.5[effort=high,fast=true]",
  );
  assert.equal(toAcpModelId(parseCursorModelId("auto"), CATALOG), "default[]");
  assert.equal(toAcpModelId(parseCursorModelId("gemini-3.5-flash"), CATALOG), "gemini-3.5-flash[]");
  assert.equal(toAcpModelId(parseCursorModelId("no-such-model"), CATALOG), undefined);
});

test("applyThinkingLevel maps OpenClaw levels onto effort", () => {
  const parsed = applyThinkingLevel(parseCursorModelId("grok-4.5-fast"), "high");
  assert.equal(parsed.effort, "high");
  const untouched = applyThinkingLevel(parseCursorModelId("grok-4.5-fast-low"), undefined);
  assert.equal(untouched.effort, "low");
});

test("toCursorModelId round-trips", () => {
  assert.equal(toCursorModelId(parseCursorModelId("grok-4.5-fast-xhigh")), "grok-4.5-fast-xhigh");
  assert.equal(
    toCursorModelId(parseCursorModelId("claude-opus-4-8-thinking-high")),
    "claude-opus-4-8-thinking-high",
  );
});

test("toSdkModel emits params for variants", () => {
  assert.deepEqual(toSdkModel(parseCursorModelId("composer-2.5")), { id: "composer-2.5" });
  assert.deepEqual(toSdkModel(parseCursorModelId("grok-4.5-fast-xhigh")), {
    id: "grok-4.5",
    params: [
      { id: "fast", value: "true" },
      { id: "effort", value: "xhigh" },
    ],
  });
  assert.deepEqual(toSdkModel(parseCursorModelId("auto")), { id: "auto" });
});
