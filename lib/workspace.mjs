import fs from "node:fs";
import path from "node:path";

function atomicWrite(target, contents) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents, "utf-8");
  fs.renameSync(tmp, target);
}

const RULE_HEADER = "---\nalwaysApply: true\n---\n";

/**
 * Same delivery trick as openclaw-cursor-agent: neither `agent acp` nor the
 * SDK take a system-prompt argument OpenClaw can use directly, but both load
 * workspace rules. Shares the openclaw.mdc path with the spawn plugin so
 * switching backends replaces (not duplicates) the injected prompt.
 */
export function writeSystemPromptRuleFile(workspaceDir, systemPrompt, overlay) {
  const sections = [systemPrompt.trim()];
  if (overlay?.trim()) sections.push(overlay.trim());
  atomicWrite(
    path.join(workspaceDir, ".cursor", "rules", "openclaw.mdc"),
    `${RULE_HEADER}${sections.join("\n\n")}\n`,
  );
}
