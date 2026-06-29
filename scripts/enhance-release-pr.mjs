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
import { execFile } from "child_process";
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

  // Deduplicate by entry content. A single changeset that targets multiple
  // packages is rendered once per package section, so the same text repeats and
  // we collapse it. But several distinct changesets from one PR have distinct
  // text (and each still carries that PR's link), so keying on content keeps
  // them all instead of dropping every entry after the first for that PR.
  const seen = new Set();

  // A standalone dependency-bump list item, e.g. "`@trigger.dev/core@4.5.0-rc.7`"
  // or "trigger.dev@4.5.0-rc.7". These normally appear nested under
  // "Updated dependencies:" (and so get swallowed into that item below), but we
  // guard against them showing up on their own too. Crucially this only matches
  // a line that is *entirely* a package bump, so a real changeset that merely
  // begins with a package name (e.g. "`@trigger.dev/sdk` now bundles ...") is
  // kept.
  const depBumpPattern = /^`?(?:@trigger\.dev\/[\w-]+|trigger\.dev)@[\w.+-]+`?$/;

  // Group lines into top-level list items. A top-level item starts with a bullet
  // at column 0 ("- " / "* "); every indented or blank line below it (sub-bullets,
  // fenced code blocks, continuation paragraphs) belongs to that same item.
  const items = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    while (current.length > 1 && current[current.length - 1].trim() === "") {
      current.pop();
    }
    items.push(current);
    current = null;
  };

  for (const line of body.split("\n")) {
    const isTopLevelBullet = /^[-*]\s+/.test(line);
    if (isTopLevelBullet) {
      flush();
      current = [line];
    } else if (current) {
      if (line.trim() === "" || /^\s/.test(line)) {
        current.push(line);
      } else {
        // A non-indented, non-blank, non-bullet line (heading or prose) ends the item
        flush();
      }
    }
  }
  flush();

  for (const itemLines of items) {
    const headLine = itemLines[0].replace(/^[-*]\s+/, "").trim();
    if (!headLine) continue;

    // Skip dependency-only updates
    if (headLine.startsWith("Updated dependencies")) continue;
    if (depBumpPattern.test(headLine)) continue;

    // Reconstruct the full item: head line + dedented continuation lines, so
    // code blocks and sub-bullets survive. Continuation under a "-   " item is
    // indented 4 spaces; strip up to 4 to bring it back to the base level.
    const continuation = itemLines.slice(1).map((l) => l.replace(/^ {1,4}/, ""));
    const text = [headLine, ...continuation].join("\n").replace(/\s+$/, "");

    // Deduplicate on the full entry text (which embeds the PR link). The same
    // changeset echoed across package sections collapses to one, while multiple
    // distinct changesets from a single PR are each preserved.
    const dedupeKey = text.replace(/\s+/g, " ").trim();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    // Categorize off the head line
    const lower = headLine.toLowerCase();
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

// --- Git + GitHub helpers for finding PR numbers ---

const REPO = "triggerdotdev/trigger.dev";

function gitExec(args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: ROOT_DIR, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

async function getCommitForFile(filePath) {
  try {
    // Find the commit that added this file
    const sha = await gitExec(["log", "--diff-filter=A", "--format=%H", "--", filePath]);
    return sha.split("\n")[0] || null;
  } catch {
    return null;
  }
}

async function getPrForCommit(commitSha) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token || !commitSha) return null;

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${commitSha}/pulls`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    if (!res.ok) return null;

    const pulls = await res.json();
    if (!pulls.length) return null;

    // Prefer merged PRs, earliest merge first (same logic as @changesets/get-github-info)
    const sorted = pulls.sort((a, b) => {
      if (!a.merged_at && !b.merged_at) return 0;
      if (!a.merged_at) return 1;
      if (!b.merged_at) return -1;
      return new Date(a.merged_at) - new Date(b.merged_at);
    });

    return sorted[0].number;
  } catch {
    return null;
  }
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

  // Collect file info and look up commits in parallel
  const fileData = [];
  for (const file of files) {
    if (!file.endsWith(".md") || file === "README.md") continue;

    const filePath = join(".server-changes", file);
    const content = await fs.readFile(join(dir, file), "utf-8");
    const parsed = parseFrontmatter(content);
    if (!parsed.body.trim()) continue;

    fileData.push({ filePath, parsed });
  }

  // Look up commits for all files in parallel
  const commits = await Promise.all(fileData.map((f) => getCommitForFile(f.filePath)));

  // Look up PRs for all commits in parallel
  const prNumbers = await Promise.all(commits.map((sha) => getPrForCommit(sha)));

  for (let i = 0; i < fileData.length; i++) {
    const { parsed } = fileData[i];
    let text = parsed.body.trim();
    const pr = prNumbers[i];

    // Append PR link if we found one and it's not already in the text
    if (pr && !text.includes(`#${pr}`)) {
      text += ` ([#${pr}](https://github.com/${REPO}/pull/${pr}))`;
    }

    entries.push({
      text,
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

// Render an entry as a list item, re-indenting continuation lines (code blocks,
// sub-bullets, paragraphs) by 2 spaces so they stay inside the "- " bullet.
function renderEntry(text) {
  return `- ${text.replace(/\n/g, "\n  ")}`;
}

function formatPrBody({ version, packageEntries, serverEntries, rawBody }) {
  const lines = [];

  const features = packageEntries.filter((e) => e.type === "feature");
  const fixes = packageEntries.filter((e) => e.type === "fix");
  const improvements = packageEntries.filter((e) => e.type === "improvement" || e.type === "other");
  const breaking = packageEntries.filter((e) => e.type === "breaking");

  const serverFeatures = serverEntries.filter((e) => e.type === "feature");
  const serverFixes = serverEntries.filter((e) => e.type === "fix");
  const serverImprovements = serverEntries.filter((e) => e.type === "improvement");
  const serverBreaking = serverEntries.filter((e) => e.type === "breaking");

  const totalFeatures = features.length + serverFeatures.length;
  const totalFixes = fixes.length + serverFixes.length;
  const totalImprovements = improvements.length + serverImprovements.length;

  // Summary line
  const parts = [];
  if (totalFeatures > 0) parts.push(`${totalFeatures} new feature${totalFeatures > 1 ? "s" : ""}`);
  if (totalImprovements > 0)
    parts.push(`${totalImprovements} improvement${totalImprovements > 1 ? "s" : ""}`);
  if (totalFixes > 0) parts.push(`${totalFixes} bug fix${totalFixes > 1 ? "es" : ""}`);
  if (parts.length > 0) {
    lines.push(`## Summary`);
    lines.push(`${parts.join(", ")}.`);
    lines.push("");
  }

  // Breaking changes
  if (breaking.length > 0 || serverBreaking.length > 0) {
    lines.push("## Breaking changes");
    for (const entry of [...breaking, ...serverBreaking]) lines.push(renderEntry(entry.text));
    lines.push("");
  }

  // Highlights (features)
  if (features.length > 0) {
    lines.push("## Highlights");
    lines.push("");
    for (const entry of features) {
      lines.push(renderEntry(entry.text));
    }
    lines.push("");
  }

  // Improvements
  if (improvements.length > 0) {
    lines.push("## Improvements");
    for (const entry of improvements) lines.push(renderEntry(entry.text));
    lines.push("");
  }

  // Bug fixes
  if (fixes.length > 0) {
    lines.push("## Bug fixes");
    for (const entry of fixes) lines.push(renderEntry(entry.text));
    lines.push("");
  }

  // Server changes
  const allServer = [...serverFeatures, ...serverImprovements, ...serverFixes];
  if (allServer.length > 0) {
    lines.push("## Server changes");
    lines.push("");
    lines.push("These changes affect the self-hosted Docker image and Trigger.dev Cloud:");
    lines.push("");
    for (const entry of allServer) {
      lines.push(renderEntry(entry.text));
    }
    lines.push("");
  }

  // Raw changeset output in collapsed section
  if (rawBody) {
    // Strip the Changesets action boilerplate from the raw body
    const cleanedBody = rawBody
      .replace(
        /This PR was opened by the \[Changesets release\].*?If you're not ready to do a release yet.*?\n/gs,
        ""
      )
      .trim();

    if (cleanedBody) {
      lines.push("<details>");
      lines.push("<summary>Raw changeset output</summary>");
      lines.push("");
      lines.push(cleanedBody);
      lines.push("");
      lines.push("</details>");
    }
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
