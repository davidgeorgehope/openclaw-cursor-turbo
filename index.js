import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildCursorAcpBackend, buildCursorSdkBackend } from "./lib/backends.js";

export default definePluginEntry({
  id: "cursor-turbo",
  name: "Cursor Turbo (ACP + SDK)",
  description:
    "Experimental low-latency Cursor backends: persistent `agent acp` server (cursor-acp/...) and in-process @cursor/sdk agents (cursor-sdk/...), both behind a warm daemon",
  register(api) {
    api.registerCliBackend(buildCursorAcpBackend());
    api.registerCliBackend(buildCursorSdkBackend());
  },
});
