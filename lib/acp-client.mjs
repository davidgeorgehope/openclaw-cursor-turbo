import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * Minimal JSON-RPC 2.0 client over a child process's stdio, for
 * `agent acp` (Agent Client Protocol). Emits:
 *  - "update" (params) for session/update notifications
 *  - "request" ({ id, method, params, respond }) for agent->client requests
 *  - "exit" when the child dies
 */
export class AcpClient extends EventEmitter {
  constructor({ command = "agent", args = ["acp"], cwd, env } = {}) {
    super();
    this.child = spawn(command, args, {
      cwd: cwd ?? process.cwd(),
      env: env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.alive = true;
    this.stderrTail = "";
    let buf = "";
    this.child.stdout.on("data", (chunk) => {
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
          continue;
        }
        this.dispatch(msg);
      }
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    this.child.on("exit", (code) => {
      this.alive = false;
      for (const { reject } of this.pending.values()) {
        reject(new Error(`agent acp exited (code ${code}): ${this.stderrTail.slice(-500)}`));
      }
      this.pending.clear();
      this.emit("exit", code);
    });
  }

  dispatch(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(Object.assign(new Error(msg.error.message ?? "ACP error"), { rpc: msg.error }));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (msg.id !== undefined && msg.method) {
      this.emit("request", {
        id: msg.id,
        method: msg.method,
        params: msg.params,
        respond: (result) => this.write({ jsonrpc: "2.0", id: msg.id, result }),
        fail: (message) =>
          this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message } }),
      });
      return;
    }
    if (msg.method === "session/update") this.emit("update", msg.params);
  }

  write(obj) {
    if (!this.alive) return;
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  request(method, params, timeoutMs = 600e3) {
    if (!this.alive) return Promise.reject(new Error("agent acp process is not running"));
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  kill() {
    this.alive = false;
    try {
      this.child.kill();
    } catch {
      // Already gone.
    }
  }
}
