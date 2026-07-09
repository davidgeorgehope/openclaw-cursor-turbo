import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";
import { DEFAULT_MODEL_ALIASES } from "./models.mjs";
import { writeSystemPromptRuleFile } from "./workspace.mjs";

const SHIM_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "shim.mjs");

const TURBO_OVERLAY = `## Cursor turbo backend environment

You are running through a warm Cursor agent transport as an OpenClaw backend. Your reply text is relayed by OpenClaw to the user's chat channel. OpenClaw-provided tools (message, sessions, cron, etc.) arrive as MCP tools. You cannot change your own model or session settings; do not invent switch confirmations. Do not use MCP tools whose names start with "plugin-".`;

function warnOnce(message, error) {
  console.warn(
    `cursor-turbo: ${message}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function transformSystemPrompt(ctx) {
  const workspaceDir = ctx.workspaceDir?.trim();
  if (!workspaceDir) return ctx.systemPrompt;
  try {
    writeSystemPromptRuleFile(workspaceDir, ctx.systemPrompt, TURBO_OVERLAY);
  } catch (error) {
    warnOnce("failed to write system prompt rule", error);
  }
  return ctx.systemPrompt;
}

function resolveExecutionArgs(ctx) {
  // Keep OpenClaw-injected args (incl. --mcp-config) intact; the shim parses
  // what it understands and ignores the rest. Append model + thinking.
  const args = [...ctx.baseArgs];
  const aliases = { ...DEFAULT_MODEL_ALIASES };
  const modelId = aliases[ctx.modelId?.trim?.() ?? ""] ?? ctx.modelId;
  if (modelId) args.push("--model", modelId);
  if (ctx.thinkingLevel) args.push("--thinking", String(ctx.thinkingLevel));
  return args;
}

function buildBackend({ id, transport, defaultModelRef }) {
  const baseArgs = [SHIM_PATH, "--transport", transport];
  return {
    id,
    liveTest: {
      defaultModelRef,
      defaultImageProbe: true,
      defaultMcpProbe: true,
    },
    nativeToolMode: "always-on",
    sideQuestionToolMode: "disabled",
    ownsNativeCompaction: true,
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    resolveExecutionArgs,
    transformSystemPrompt,
    config: {
      command: process.execPath,
      args: [...baseArgs],
      resumeArgs: [...baseArgs, "--resume", "{sessionId}"],
      output: "jsonl",
      jsonlDialect: "claude-stream-json",
      input: "stdin",
      modelAliases: { ...DEFAULT_MODEL_ALIASES },
      sessionMode: "existing",
      sessionIdFields: ["session_id"],
      systemPromptWhen: "never",
      imageArg: "--image",
      imageMode: "repeat",
      imagePathScope: "workspace",
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
  };
}

export function buildCursorAcpBackend() {
  return buildBackend({
    id: "cursor-acp",
    transport: "acp",
    defaultModelRef: "cursor-acp/composer-2.5",
  });
}

export function buildCursorSdkBackend() {
  return buildBackend({
    id: "cursor-sdk",
    transport: "sdk",
    defaultModelRef: "cursor-sdk/composer-2.5",
  });
}
