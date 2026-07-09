import fs from "node:fs";
import path from "node:path";
import { AcpClient } from "./acp-client.mjs";
import { toAcpMcpServers } from "./mcp.mjs";
import { applyThinkingLevel, parseCursorModelId, toAcpModelId } from "./models.mjs";

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function imageBlockFromPath(imagePath) {
  const data = fs.readFileSync(imagePath).toString("base64");
  const mimeType = MIME_BY_EXT[path.extname(imagePath).toLowerCase()] ?? "image/png";
  return { type: "image", data, mimeType };
}

/**
 * Persistent `agent acp` child hosting many sessions. One instance per
 * daemon; the child is restarted lazily when it dies. Sessions survive child
 * restarts via session/load (Cursor persists chats on disk).
 */
export class AcpTransport {
  constructor({ command = "agent", log = () => {} } = {}) {
    this.command = command;
    this.log = log;
    this.client = null;
    // sessionId -> { models: availableModels[], currentModelId, mcpFingerprint }
    this.sessions = new Map();
  }

  async ensureClient() {
    if (this.client?.alive) return this.client;
    const client = new AcpClient({ command: this.command, args: ["acp"] });
    client.on("request", (req) => this.handleAgentRequest(req));
    client.on("exit", (code) => {
      this.log(`acp child exited (${code}); sessions require session/load on next turn`);
      this.sessions.clear();
    });
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    this.client = client;
    return client;
  }

  handleAgentRequest(req) {
    if (req.method === "session/request_permission") {
      // Headless: mirror --force by picking the broadest allow option.
      const options = req.params?.options ?? [];
      const pick =
        options.find((o) => /allow_always/i.test(o.kind ?? "")) ??
        options.find((o) => /allow/i.test(o.kind ?? "")) ??
        options[0];
      req.respond({ outcome: { outcome: "selected", optionId: pick?.optionId } });
      return;
    }
    // fs/terminal capabilities are not advertised; refuse anything else.
    req.fail(`unsupported client method: ${req.method}`);
  }

  async resolveSession({ resume, cwd, mcpServers }) {
    const client = await this.ensureClient();
    const acpMcp = toAcpMcpServers(mcpServers);
    // OpenClaw's MCP bridge endpoints/tokens are per-run; a session bound to
    // last turn's bridge has dead tool connections. Reload whenever the
    // resolved server set changes.
    const fingerprint = JSON.stringify(acpMcp);
    if (resume) {
      const state = this.sessions.get(resume);
      if (state && state.mcpFingerprint === fingerprint) {
        this.log(`acp: reusing live session ${resume}`);
        return { client, sessionId: resume };
      }
      this.log(`acp: session/load ${resume} (live=${Boolean(state)})`);
      const loaded = await client.request("session/load", {
        sessionId: resume,
        cwd,
        mcpServers: acpMcp,
      });
      this.sessions.set(resume, {
        models: loaded?.models?.availableModels ?? state?.models ?? [],
        currentModelId: loaded?.models?.currentModelId ?? state?.currentModelId,
        mcpFingerprint: fingerprint,
      });
      return { client, sessionId: resume };
    }
    const created = await client.request("session/new", { cwd, mcpServers: acpMcp });
    this.sessions.set(created.sessionId, {
      models: created?.models?.availableModels ?? [],
      currentModelId: created?.models?.currentModelId,
      mcpFingerprint: fingerprint,
    });
    return { client, sessionId: created.sessionId };
  }

  async ensureModel(client, sessionId, model, thinkingLevel) {
    if (!model) return;
    const state = this.sessions.get(sessionId) ?? { models: [], currentModelId: undefined };
    const parsed = applyThinkingLevel(parseCursorModelId(model), thinkingLevel);
    const target = toAcpModelId(parsed, state.models);
    if (!target) {
      this.log(`acp: model "${model}" not found in session catalog; keeping ${state.currentModelId}`);
      return;
    }
    if (target === state.currentModelId) return;
    await client.request("session/set_model", { sessionId, modelId: target });
    state.currentModelId = target;
    this.sessions.set(sessionId, state);
  }

  /**
   * Runs one turn. Calls emit(event) with claude-stream-json shaped objects.
   * Returns the final result payload.
   */
  async runTurn({ cwd, model, thinkingLevel, prompt, imagePaths = [], resume, mcpServers }, emit) {
    const started = Date.now();
    const { client, sessionId } = await this.resolveSession({ resume, cwd, mcpServers });
    await this.ensureModel(client, sessionId, model, thinkingLevel);

    emit({
      type: "system",
      subtype: "init",
      cwd,
      session_id: sessionId,
      model: this.sessions.get(sessionId)?.currentModelId ?? model ?? "auto",
      permissionMode: "default",
      transport: "acp",
    });

    const content = [{ type: "text", text: prompt }];
    for (const imagePath of imagePaths) {
      try {
        content.push(imageBlockFromPath(imagePath));
      } catch (error) {
        this.log(`acp: failed to read image ${imagePath}: ${error.message}`);
      }
    }

    let assistantText = "";
    const onUpdate = (params) => {
      if (params?.sessionId !== sessionId) return;
      const update = params.update ?? {};
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const text = update.content?.text ?? "";
          assistantText += text;
          break;
        }
        case "agent_thought_chunk": {
          const text = update.content?.text ?? "";
          if (text) {
            emit({ type: "thinking", subtype: "delta", text, session_id: sessionId });
          }
          break;
        }
        case "tool_call": {
          emit({
            type: "tool_call",
            subtype: "started",
            session_id: sessionId,
            tool_call: {
              id: update.toolCallId,
              name: update.title ?? update.kind ?? "tool",
              kind: update.kind,
            },
          });
          break;
        }
        case "tool_call_update": {
          if (update.status === "completed" || update.status === "failed") {
            emit({
              type: "tool_call",
              subtype: update.status,
              session_id: sessionId,
              tool_call: { id: update.toolCallId },
            });
          }
          break;
        }
        default:
          break;
      }
    };

    client.on("update", onUpdate);
    try {
      const result = await client.request("session/prompt", {
        sessionId,
        prompt: content,
      });
      emit({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: assistantText }] },
        session_id: sessionId,
      });
      const isError = result?.stopReason === "refusal" || result?.stopReason === "error";
      emit({
        type: "result",
        subtype: isError ? "error" : "success",
        is_error: isError,
        result: assistantText,
        duration_ms: Date.now() - started,
        session_id: sessionId,
        stop_reason: result?.stopReason,
      });
      return { sessionId, assistantText };
    } finally {
      client.off("update", onUpdate);
    }
  }

  stop() {
    this.client?.kill();
    this.client = null;
    this.sessions.clear();
  }
}
