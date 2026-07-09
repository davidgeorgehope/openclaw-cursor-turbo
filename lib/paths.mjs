import os from "node:os";
import path from "node:path";

export const STATE_DIR = path.join(os.homedir(), ".openclaw-cursor-turbo");
export const SOCKET_PATH = path.join(STATE_DIR, "daemon.sock");
export const PID_PATH = path.join(STATE_DIR, "daemon.pid");
export const LOG_PATH = path.join(STATE_DIR, "daemon.log");
