import fs from "node:fs";
import path from "node:path";
import { toSdkMcpServers } from "./mcp.mjs";
import { applyThinkingLevel, parseCursorModelId } from "./models.mjs";

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Maps a parsed cursor-style model id to @cursor/sdk { id, params }. */
export function toSdkModel(parsed) {
  if (parsed.raw) return { id: parsed.raw };
  if (parsed.base === "auto") return { id: "auto" };
  const params = [];
  if (parsed.fast) params.push({ id: "fast", value: "true" });
  if (parsed.effort) params.push({ id: "effort", value: parsed.effort });
  if (parsed.thinking) params.push({ id: "thinking", value: "true" });
  return params.length ? { id: parsed.base, params } : { id: parsed.base };
}

/**
 * In-process @cursor/sdk local agents. The agent loop runs inside the daemon
 * process; no child process per turn. Agents are cached by agentId and
 * rehydrated with Agent.resume() after a daemon restart.
 */
export class SdkTransport {
  constructor({ apiKey, log = () => {} } = {}) {
    this.apiKey = apiKey;
    this.log = log;
    this.agents = new Map(); // agentId -> agent handle
    this.sdk = null;
  }

  async ensureSdk() {
    if (!this.sdk) this.sdk = await import("@cursor/sdk");
    return this.sdk;
  }

  resolveApiKey() {
    const key = this.apiKey ?? process.env.CURSOR_API_KEY;
    if (!key) {
      throw new Error(
        "cursor-sdk transport needs a Cursor API key. Create one at cursor.com/dashboard -> API Keys, " +
          "then set it in ~/.openclaw-cursor-turbo/config.json ({\"apiKey\": \"...\"}) or CURSOR_API_KEY.",
      );
    }
    return key;
  }

  async resolveAgent({ resume, cwd, model, mcpServers }) {
    const { Agent } = await this.ensureSdk();
    const apiKey = this.resolveApiKey();
    const sdkMcp = toSdkMcpServers(mcpServers);
    const mcpOption = Object.keys(sdkMcp).length ? { mcpServers: sdkMcp } : {};
    if (resume) {
      const cached = this.agents.get(resume);
      if (cached) return cached;
      const agent = await Agent.resume(resume, { apiKey, ...mcpOption });
      this.agents.set(resume, agent);
      return agent;
    }
    const agent = await Agent.create({
      apiKey,
      model,
      local: { cwd, settingSources: ["project"] },
      ...mcpOption,
    });
    this.agents.set(agent.agentId, agent);
    return agent;
  }

  async runTurn({ cwd, model, thinkingLevel, prompt, imagePaths = [], resume, mcpServers }, emit) {
    const started = Date.now();
    const parsed = applyThinkingLevel(parseCursorModelId(model), thinkingLevel);
    const sdkModel = toSdkModel(parsed);
    const agent = await this.resolveAgent({ resume, cwd, model: sdkModel, mcpServers });
    const sessionId = agent.agentId;

    emit({
      type: "system",
      subtype: "init",
      cwd,
      session_id: sessionId,
      model: sdkModel.id,
      permissionMode: "default",
      transport: "sdk",
    });

    const images = [];
    for (const imagePath of imagePaths) {
      try {
        images.push({
          data: fs.readFileSync(imagePath).toString("base64"),
          mimeType: MIME_BY_EXT[path.extname(imagePath).toLowerCase()] ?? "image/png",
        });
      } catch (error) {
        this.log(`sdk: failed to read image ${imagePath}: ${error.message}`);
      }
    }

    const message = images.length ? { text: prompt, images } : prompt;
    const sendOptions = resume ? { model: sdkModel } : undefined;
    const run = await agent.send(message, sendOptions);

    let assistantText = "";
    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message?.content ?? []) {
          if (block.type === "text") assistantText += block.text;
        }
      } else if (event.type === "thinking") {
        const text = event.message?.content?.find?.((b) => b.type === "text")?.text ?? event.text;
        if (text) emit({ type: "thinking", subtype: "delta", text, session_id: sessionId });
      }
    }
    const result = await run.wait();

    emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: assistantText }] },
      session_id: sessionId,
    });
    const isError = result?.status === "error";
    emit({
      type: "result",
      subtype: isError ? "error" : "success",
      is_error: isError,
      result: assistantText,
      duration_ms: Date.now() - started,
      session_id: sessionId,
      status: result?.status,
    });
    return { sessionId, assistantText };
  }

  async stop() {
    for (const agent of this.agents.values()) {
      try {
        await agent[Symbol.asyncDispose]?.();
      } catch {
        // Best effort.
      }
    }
    this.agents.clear();
  }
}
