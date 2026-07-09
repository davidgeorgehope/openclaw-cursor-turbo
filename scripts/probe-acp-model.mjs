// Probe model-selection + session-load methods on `agent acp`.
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "acp-probe-"));
const child = spawn("agent", ["acp"], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });

let nextId = 1;
const pending = new Map();
function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => {
    pending.set(id, resolve);
    setTimeout(() => resolve({ __timeout: method }), 20e3);
  });
}
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      pending.get(msg.id)?.(msg.error ? { __error: msg.error } : msg.result);
      pending.delete(msg.id);
    } else if (msg.id !== undefined && msg.method) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
    } else if (msg.method === "session/update") {
      const u = msg.params?.update;
      if (u?.sessionUpdate === "agent_message_chunk") process.stderr.write(u.content?.text ?? "");
      if (u?.sessionUpdate === "current_model_update" || u?.sessionUpdate === "config_option_update")
        console.error(`\n[update] ${JSON.stringify(u).slice(0, 300)}`);
    }
  }
});

await send("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } });
const sess = await send("session/new", { cwd: workspace, mcpServers: [] });
console.error(`session: ${sess.sessionId}, current model: ${sess.models?.currentModelId}`);

for (const method of ["session/set_model", "session/select_model", "session/set_config_option"]) {
  const params =
    method === "session/set_config_option"
      ? { sessionId: sess.sessionId, configOptionId: "model", value: "gemini-3.5-flash[]" }
      : { sessionId: sess.sessionId, modelId: "gemini-3.5-flash[]" };
  const res = await send(method, params);
  console.error(`${method}: ${JSON.stringify(res).slice(0, 200)}`);
}

console.error("--- prompt after model switch:");
const t = Date.now();
await send("session/prompt", {
  sessionId: sess.sessionId,
  prompt: [{ type: "text", text: "Which model are you? One short line." }],
});
console.error(`\n--- done in ${Date.now() - t}ms`);

// Test session/load in a second process for resume-after-restart.
child.kill();
const child2 = spawn("agent", ["acp"], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
const pending2 = new Map();
let nextId2 = 1;
function send2(method, params) {
  const id = nextId2++;
  child2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => {
    pending2.set(id, resolve);
    setTimeout(() => resolve({ __timeout: method }), 30e3);
  });
}
let buf2 = "";
child2.stdout.on("data", (chunk) => {
  buf2 += chunk;
  let idx;
  while ((idx = buf2.indexOf("\n")) >= 0) {
    const line = buf2.slice(0, idx).trim();
    buf2 = buf2.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      pending2.get(msg.id)?.(msg.error ? { __error: msg.error } : msg.result);
      pending2.delete(msg.id);
    } else if (msg.id !== undefined && msg.method) {
      child2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
    } else if (msg.method === "session/update") {
      const u = msg.params?.update;
      if (u?.sessionUpdate === "agent_message_chunk") process.stderr.write(u.content?.text ?? "");
    }
  }
});
await send2("initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } });
const loaded = await send2("session/load", { sessionId: sess.sessionId, cwd: workspace, mcpServers: [] });
console.error(`\nsession/load: ${JSON.stringify(loaded).slice(0, 300)}`);
const t2 = Date.now();
await send2("session/prompt", {
  sessionId: sess.sessionId,
  prompt: [{ type: "text", text: "What was the FIRST thing I asked you in this conversation? One line." }],
});
console.error(`\n--- resumed prompt done in ${Date.now() - t2}ms`);
child2.kill();
process.exit(0);
