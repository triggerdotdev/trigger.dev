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

  // Deduplicate by PR number
  const seen = new Set();
  const prPattern = /\[#(\d+)\]\(([^)]+)\)/;

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ") && !trimmed.startsWith("* ")) continue;

    let text = trimmed.replace(/^[-*]\s+/, "").trim();
    if (!text) continue;

    // Skip dependency-only updates (e.g. "Updated dependencies:" or "@trigger.dev/core@4.4.2")
    if (text.startsWith("Updated dependencies")) continue;
    if (text.startsWith("`@trigger.dev/")) continue;
    if (text.startsWith("@trigger.dev/")) continue;
    if (text.startsWith("`trigger.dev@")) continue;
    if (text.startsWith("trigger.dev@")) continue;

    const prMatch = trimmed.match(prPattern);
    if (prMatch) {
      const prNumber = prMatch[1];
      if (seen.has(prNumber)) continue;
      seen.add(prNumber);
    }

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

/**
 * Render the enhanced release PR body.
 *
 * @param {object} args
 * @param {string} args.version - Proposed release version (e.g. "4.4.6").
 * @param {Array<{text: string, type: string}>} args.packageEntries - Entries parsed from the changesets-generated PR body.
 * @param {Array<{text: string, type: string, area: string}>} args.serverEntries - Entries parsed from .server-changes/*.md.
 * @param {string} args.rawBody - The original changesets-generated PR body (kept in a collapsed details section).
 * @param {{sourceBranch: string, currentLatest: string, willBeLatest: boolean, lineMatch: string|null}|null} args.releaseContext - Release-branch context (only set when SOURCE_BRANCH env is present); drives the "Release prep" header.
 * @returns {string} Markdown body.
 */
function formatPrBody({ version, packageEntries, serverEntries, rawBody, releaseContext }) {
  const lines = [];

  // Release-branch context header. Surfaces whether this PR will become the
  // npm `latest` / Docker `:v4-beta` / GitHub "Latest" — surprising on
  // release-branch hotfixes.
  if (releaseContext) {
    const { sourceBranch, currentLatest, willBeLatest, lineMatch } = releaseContext;
    lines.push("## Release prep");
    lines.push("");
    lines.push(`- **Version:** \`${version}\``);
    lines.push(`- **Source branch:** \`${sourceBranch}\``);
    lines.push(`- **Current \`latest\` on npm:** \`${currentLatest}\``);
    lines.push(
      `- **This release will become \`latest\`:** ${
        willBeLatest
          ? "✅ yes"
          : `❌ no — will publish to dist-tag \`release-${lineMatch || "?"}\``
      }`
    );
    if (sourceBranch && sourceBranch.startsWith("release/")) {
      lines.push("");
      if (willBeLatest) {
        lines.push(
          `> Hotfix on the **${lineMatch}.x** line. Becomes \`latest\` because the current latest (${currentLatest}) is older. Customers running \`npm install\` will pick this up.`
        );
      } else {
        lines.push(
          `> Hotfix on the **${lineMatch}.x** line. Will NOT become \`latest\` because main has shipped a higher version (${currentLatest}). Customers wanting this fix on the ${lineMatch}.x line should pin: \`npm install @trigger.dev/sdk@release-${lineMatch}\`.`
        );
      }
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

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
    for (const entry of [...breaking, ...serverBreaking]) lines.push(`- ${entry.text}`);
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
  const allServer = [...serverFeatures, ...serverImprovements, ...serverFixes];
  if (allServer.length > 0) {
    lines.push("## Server changes");
    lines.push("");
    lines.push("These changes affect the self-hosted Docker image and Trigger.dev Cloud:");
    lines.push("");
    for (const entry of allServer) {
      // Indent continuation lines so multi-line entries stay inside the list item
      const indented = entry.text.replace(/\n/g, "\n  ");
      lines.push(`- ${indented}`);
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

/**
 * Build release-branch context for the PR body header.
 *
 * Reads SOURCE_BRANCH from the environment (set by changesets-pr.yml). When
 * present, queries npm for the current `latest` dist-tag of @trigger.dev/sdk,
 * compares the proposed version against it, and returns context for rendering
 * the "Release prep" header. Returns null when SOURCE_BRANCH is unset (so the
 * header is omitted on plain main releases that don't need branch context).
 *
 * @returns {Promise<{sourceBranch: string, currentLatest: string, willBeLatest: boolean, lineMatch: string|null}|null>}
 */
async function getReleaseContext() {
  const sourceBranch = process.env.SOURCE_BRANCH;
  if (!sourceBranch) return null;

  // Look up current npm `latest` for the canonical package
  let currentLatest = "0.0.0";
  try {
    const out = await new Promise((resolve) => {
      execFile(
        "npm",
        ["view", "@trigger.dev/sdk", "dist-tags.latest"],
        { maxBuffer: 1024 * 1024 },
        (err, stdout) => resolve(err ? "" : stdout.trim())
      );
    });
    if (out && out !== "undefined") currentLatest = out;
  } catch {
    // fall through with default
  }

  const cmp = (a, b) =>
    a.split(".").map(Number).reduce((acc, n, i) => acc || n - (b.split(".").map(Number)[i] ?? 0), 0);
  const willBeLatest = cmp(version, currentLatest) > 0;

  const m = sourceBranch.match(/^release\/(\d+\.\d+)\.x$/);
  const lineMatch = m ? m[1] : null;

  return { sourceBranch, currentLatest, willBeLatest, lineMatch };
}

async function main() {
  let rawBody = process.env.CHANGESET_PR_BODY || "";
  if (!rawBody && !process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    rawBody = Buffer.concat(chunks).toString("utf-8");
  }

  const packageEntries = parsePrBody(rawBody);
  const serverEntries = await parseServerChanges();
  const releaseContext = await getReleaseContext();

  const body = formatPrBody({
    version,
    packageEntries,
    serverEntries,
    rawBody,
    releaseContext,
  });

  process.stdout.write(body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
