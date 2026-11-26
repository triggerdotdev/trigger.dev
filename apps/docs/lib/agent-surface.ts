import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { docsUrl } from "./source";
import { basePath } from "./base-path";

export const siteDescription =
  "Trigger.dev is an open source background jobs framework that lets you write reliable workflows in plain async code. Run long-running AI tasks, handle complex background jobs, and build AI agents with built-in queuing, automatic retries, and real-time monitoring. No timeouts, elastic scaling, and zero infrastructure management required.";

/** Read at build time: every route that uses it is static. */
export const skill = readFileSync(path.join(process.cwd(), "content/skill.md"), "utf8");
export const skillDigest = `sha256:${createHash("sha256").update(skill).digest("hex")}`;
export const skillDescription = /description: ([\s\S]*?)\n\w+:/
  .exec(skill)![1]!
  .replace(/\s+/g, " ")
  .trim();
export const skillUrl = `${basePath}/.well-known/agent-skills/trigger/skill.md`;

/** The llms-full slice for each top-level docs section, e.g. `api-reference.txt`. */
export const sectionFile = (section: string) =>
  `${section
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}.txt`;

export const mcpUrl = `${docsUrl}/mcp`;
