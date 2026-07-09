// Manual probe of `agent acp` (Agent Client Protocol over stdio).
// Sends initialize -> session/new -> session/prompt and dumps every JSON-RPC
// message so we can see the real event shapes before building the daemon.
import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "acp-probe-"));
console.error(`workspace: ${workspace}`);

const child = spawn("agent", ["acp"], {
  cwd: workspace,
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", (d) => console.error(`[stderr] ${d}`));

let nextId = 1;
const pending = new Map();

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  console.error(`>>> ${JSON.stringify(msg)}`);
  child.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 120e3);
  });
}

function respond(id, result) {
  const msg = { jsonrpc: "2.0", id, result };
  console.error(`>>> ${JSON.stringify(msg)}`);
  child.stdin.write(JSON.stringify(msg) + "\n");
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
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`[raw] ${line}`);
      continue;
    }
    console.error(`<<< ${JSON.stringify(msg).slice(0, 600)}`);
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    } else if (msg.id !== undefined && msg.method) {
      // Agent -> client request. Auto-grant permissions, stub everything else.
      if (msg.method === "session/request_permission") {
        const opts = msg.params?.options ?? [];
        const allow =
          opts.find((o) => /allow.*always/i.test(o.kind ?? o.optionId ?? "")) ?? opts[0];
        respond(msg.id, { outcome: { outcome: "selected", optionId: allow?.optionId } });
      } else if (msg.method === "fs/read_text_file") {
        try {
          respond(msg.id, { content: fs.readFileSync(msg.params.path, "utf8") });
        } catch (e) {
          respond(msg.id, { content: "" });
        }
      } else {
        respond(msg.id, {});
      }
    }
  }
});

const t0 = Date.now();
const init = await send("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
});
console.error(`--- initialize done in ${Date.now() - t0}ms`);
console.error(`--- agent capabilities: ${JSON.stringify(init).slice(0, 1500)}`);

const t1 = Date.now();
const sess = await send("session/new", { cwd: workspace, mcpServers: [] });
console.error(`--- session/new done in ${Date.now() - t1}ms: ${JSON.stringify(sess)}`);

// Try setting the model if supported
if (sess.models || sess.modes) {
  console.error(`--- models/modes: ${JSON.stringify({ models: sess.models, modes: sess.modes }).slice(0, 800)}`);
}

const t2 = Date.now();
const res = await send("session/prompt", {
  sessionId: sess.sessionId,
  prompt: [{ type: "text", text: "Reply with exactly: PONG-1" }],
});
console.error(`--- prompt 1 done in ${Date.now() - t2}ms: ${JSON.stringify(res)}`);

const t3 = Date.now();
const res2 = await send("session/prompt", {
  sessionId: sess.sessionId,
  prompt: [{ type: "text", text: "What did I ask you to reply with before? Answer with just that token." }],
});
console.error(`--- prompt 2 (warm) done in ${Date.now() - t3}ms: ${JSON.stringify(res2)}`);

child.kill();
process.exit(0);
