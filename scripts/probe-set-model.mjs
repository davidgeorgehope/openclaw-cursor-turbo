import { AcpClient } from "../lib/acp-client.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "acp-model-"));
const client = new AcpClient({ cwd: workspace });
client.on("request", (req) => req.respond({}));
await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
const sess = await client.request("session/new", { cwd: workspace, mcpServers: [] });

const candidates = [
  "grok-4.5[effort=xhigh,fast=true]",
  "grok-4.5[fast=true,effort=xhigh]",
  "grok-4.5[effort=high,fast=true]",
  "grok-4.5[effort=xhigh]",
  "grok-4.5[effort=low,fast=true]",
  "gpt-5.5[context=272k,reasoning=high,fast=false]",
  "claude-opus-4-8[thinking=true,context=300k,effort=xhigh,fast=false]",
  "composer-2.5[fast=false]",
  "composer-2.5[]",
];
for (const modelId of candidates) {
  try {
    await client.request("session/set_model", { sessionId: sess.sessionId, modelId });
    console.log(`OK   ${modelId}`);
  } catch (error) {
    console.log(`FAIL ${modelId} -> ${JSON.stringify(error.rpc?.data ?? error.message).slice(0, 150)}`);
  }
}
client.kill();
process.exit(0);
