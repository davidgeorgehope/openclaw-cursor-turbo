// Cursor-CLI-style model ids encode fast/effort variants as suffixes, e.g.
// grok-4.5-fast-xhigh. ACP uses bracket params instead, e.g.
// grok-4.5[effort=xhigh,fast=true]. Parse one, emit the other.

export const DEFAULT_MODEL_ALIASES = Object.freeze({
  composer: "composer-2.5",
  grok: "grok-4.5-fast-xhigh",
  gpt: "gpt-5.5-high",
  opus: "claude-opus-4-8-thinking-high",
  fable: "claude-fable-5-thinking-high",
  sonnet: "claude-sonnet-5-thinking-high",
});

const EFFORTS = ["xhigh", "high", "medium", "low"];

/** Splits a cursor-style id into base name + variant hints. */
export function parseCursorModelId(modelId) {
  let rest = (modelId ?? "").trim();
  if (!rest) return { base: "auto", effort: undefined, fast: false };
  if (rest.includes("[")) return { raw: rest };
  let effort;
  for (const level of EFFORTS) {
    if (rest.endsWith(`-${level}`)) {
      effort = level;
      rest = rest.slice(0, -(level.length + 1));
      break;
    }
  }
  let fast = false;
  if (rest.endsWith("-fast")) {
    fast = true;
    rest = rest.slice(0, -5);
  }
  // cursor-agent uses "-thinking-<effort>" for Claude models; ACP encodes
  // thinking as a bracket param on the base id.
  let thinking = false;
  if (rest.endsWith("-thinking")) {
    thinking = true;
    rest = rest.slice(0, -9);
  }
  return { base: rest, effort, fast, thinking };
}

const THINKING_LEVEL_TO_EFFORT = Object.freeze({
  off: undefined,
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
});

/** Applies an OpenClaw thinking level on top of a parsed cursor-style id. */
export function applyThinkingLevel(parsed, thinkingLevel) {
  if (!thinkingLevel || parsed.raw) return parsed;
  const effort = THINKING_LEVEL_TO_EFFORT[String(thinkingLevel).toLowerCase()];
  if (!effort) return parsed;
  return { ...parsed, effort };
}

/**
 * Resolves a parsed cursor-style id against the ACP availableModels list.
 * `session/set_model` only accepts modelIds exactly as advertised, so
 * effort/fast/thinking variant requests collapse to the advertised default
 * variant of the same base model.
 */
export function toAcpModelId(parsed, availableModels) {
  if (parsed.raw) return parsed.raw;
  if (parsed.base === "auto") return "default[]";
  const match = (availableModels ?? []).find((m) => m.name === parsed.base);
  return match?.modelId;
}

/** Rebuilds a cursor-style id from parsed parts (used by the SDK transport). */
export function toCursorModelId(parsed) {
  if (parsed.raw) return parsed.raw;
  let id = parsed.base;
  if (parsed.thinking) id += "-thinking";
  if (parsed.fast) id += "-fast";
  if (parsed.effort) id += `-${parsed.effort}`;
  return id;
}
