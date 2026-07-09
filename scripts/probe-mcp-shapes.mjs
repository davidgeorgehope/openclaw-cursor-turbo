// Try several mcpServers shapes on session/new to find what agent acp accepts.
import { AcpClient } from "../lib/acp-client.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "acp-mcp-"));
const client = new AcpClient({ cwd: workspace });
client.on("request", (req) => req.respond({}));
await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });

const variants = {
  "http with headers array": [
    { type: "http", name: "web", url: "http://127.0.0.1:1/mcp", headers: [{ name: "A", value: "b" }] },
  ],
  "http no headers": [{ type: "http", name: "web", url: "http://127.0.0.1:1/mcp" }],
  "http headers object": [
    { type: "http", name: "web", url: "http://127.0.0.1:1/mcp", headers: { A: "b" } },
  ],
  "stdio minimal": [{ name: "cli", command: "true", args: [], env: [] }],
  "stdio env object": [{ name: "cli", command: "true", args: [], env: {} }],
};

for (const [label, mcpServers] of Object.entries(variants)) {
  try {
    const res = await client.request("session/new", { cwd: workspace, mcpServers }, 30e3);
    console.log(`OK   ${label} -> ${res.sessionId}`);
  } catch (error) {
    console.log(`FAIL ${label} -> ${error.message} ${JSON.stringify(error.rpc?.data ?? "").slice(0, 400)}`);
  }
}
client.kill();
process.exit(0);
