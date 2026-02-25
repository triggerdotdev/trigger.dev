#!/usr/bin/env node

/**
 * Enhances the changeset release PR with a well-written, deduplicated summary.
 *
 * Reads:
 *   - The raw changeset PR body (via CHANGESET_PR_BODY env var or stdin)
 *   - .server-changes/*.md files for server-only changes
 *
 * Outputs a formatted PR body to stdout that includes:
 *   - A clean summary with categories
 *   - Server changes section
 *   - The raw changeset output in a collapsed <details> section
 *
 * Usage:
 *   CHANGESET_PR_BODY="..." node scripts/enhance-release-pr.mjs <version>
 *   echo "$PR_BODY" | node scripts/enhance-release-pr.mjs <version>
 */

import { promises as fs } from "fs";
import { join } from "path";

const version = process.argv[2];
if (!version) {
  console.error("Usage: node scripts/enhance-release-pr.mjs <version>");
  process.exit(1);
}

const ROOT_DIR = join(import.meta.dirname, "..");

// --- Parse changeset PR body ---

function parsePrBody(body) {
  const entries = [];
  if (!body) return entries;

  // Deduplicate by PR number
  const seen = new Set();
  const prPattern = /\[#(\d+)\]\(([^)]+)\)/;

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ") && !trimmed.startsWith("* ")) continue;

    const prMatch = trimmed.match(prPattern);
    if (prMatch) {
      const prNumber = prMatch[1];
      if (seen.has(prNumber)) continue;
      seen.add(prNumber);
    }

    let text = trimmed.replace(/^[-*]\s+/, "").trim();
    if (!text) continue;

    // Categorize
    const lower = text.toLowerCase();
    let type = "improvement";
    if (lower.startsWith("fix") || lower.includes("bug fix")) {
      type = "fix";
    } else if (
      lower.startsWith("feat") ||
      lower.includes("new feature") ||
      lower.includes("add support") ||
      lower.includes("added support") ||
      lower.includes("expose") ||
      lower.includes("allow")
    ) {
      type = "feature";
    } else if (lower.includes("breaking")) {
      type = "breaking";
    }

    entries.push({ text, type });
  }

  return entries;
}

// --- Parse .server-changes/ files ---

async function parseServerChanges() {
  const dir = join(ROOT_DIR, ".server-changes");
  const entries = [];

  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return entries;
  }

  for (const file of files) {
    if (!file.endsWith(".md") || file === "README.md") continue;

    const content = await fs.readFile(join(dir, file), "utf-8");
    const parsed = parseFrontmatter(content);
    if (!parsed.body.trim()) continue;

    entries.push({
      text: parsed.body.trim(),
      type: parsed.frontmatter.type || "improvement",
      area: parsed.frontmatter.area || "webapp",
    });
  }

  return entries;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":");
    if (key && rest.length) {
      frontmatter[key.trim()] = rest.join(":").trim();
    }
  }

  return { frontmatter, body: match[2] };
}

// --- Format the enhanced PR body ---

function formatPrBody({ version, packageEntries, serverEntries, rawBody }) {
  const lines = [];

  const features = packageEntries.filter((e) => e.type === "feature");
  const fixes = packageEntries.filter((e) => e.type === "fix");
  const improvements = packageEntries.filter(
    (e) => e.type === "improvement" || e.type === "other"
  );
  const breaking = packageEntries.filter((e) => e.type === "breaking");

  const serverFeatures = serverEntries.filter((e) => e.type === "feature");
  const serverFixes = serverEntries.filter((e) => e.type === "fix");
  const serverImprovements = serverEntries.filter(
    (e) => e.type === "improvement"
  );
  const serverBreaking = serverEntries.filter((e) => e.type === "breaking");

  const totalFeatures = features.length + serverFeatures.length;
  const totalFixes = fixes.length + serverFixes.length;
  const totalImprovements = improvements.length + serverImprovements.length;

  lines.push(`# trigger.dev v${version}`);
  lines.push("");

  // Summary line
  const parts = [];
  if (totalFeatures > 0)
    parts.push(`${totalFeatures} new feature${totalFeatures > 1 ? "s" : ""}`);
  if (totalImprovements > 0)
    parts.push(
      `${totalImprovements} improvement${totalImprovements > 1 ? "s" : ""}`
    );
  if (totalFixes > 0)
    parts.push(`${totalFixes} bug fix${totalFixes > 1 ? "es" : ""}`);
  if (parts.length > 0) {
    lines.push(`## Summary`);
    lines.push(`${parts.join(", ")}.`);
    lines.push("");
  }

  // Breaking changes
  if (breaking.length > 0 || serverBreaking.length > 0) {
    lines.push("## Breaking changes");
    for (const entry of [...breaking, ...serverBreaking])
      lines.push(`- ${entry.text}`);
    lines.push("");
  }

  // Highlights (features)
  if (features.length > 0) {
    lines.push("## Highlights");
    lines.push("");
    for (const entry of features) {
      lines.push(`- ${entry.text}`);
    }
    lines.push("");
  }

  // Improvements
  if (improvements.length > 0) {
    lines.push("## Improvements");
    for (const entry of improvements) lines.push(`- ${entry.text}`);
    lines.push("");
  }

  // Bug fixes
  if (fixes.length > 0) {
    lines.push("## Bug fixes");
    for (const entry of fixes) lines.push(`- ${entry.text}`);
    lines.push("");
  }

  // Server changes
  const allServer = [
    ...serverFeatures,
    ...serverImprovements,
    ...serverFixes,
  ];
  if (allServer.length > 0) {
    lines.push("## Server changes");
    lines.push("");
    lines.push(
      "These changes affect the self-hosted Docker image and Trigger.dev Cloud:"
    );
    lines.push("");
    for (const entry of allServer) lines.push(`- ${entry.text}`);
    lines.push("");
  }

  // Raw changeset output in collapsed section
  if (rawBody) {
    lines.push("<details>");
    lines.push("<summary>Raw changeset output</summary>");
    lines.push("");
    lines.push(rawBody);
    lines.push("");
    lines.push("</details>");
  }

  return lines.join("\n");
}

// --- Main ---

async function main() {
  let rawBody = process.env.CHANGESET_PR_BODY || "";
  if (!rawBody && !process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    rawBody = Buffer.concat(chunks).toString("utf-8");
  }

  const packageEntries = parsePrBody(rawBody);
  const serverEntries = await parseServerChanges();

  const body = formatPrBody({
    version,
    packageEntries,
    serverEntries,
    rawBody,
  });

  process.stdout.write(body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
