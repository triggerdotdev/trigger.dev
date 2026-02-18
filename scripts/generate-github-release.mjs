#!/usr/bin/env node

/**
 * Generates a unified GitHub release body for a trigger.dev version release.
 *
 * Usage:
 *   node scripts/generate-github-release.mjs <version>
 *
 * Reads:
 *   - The enhanced changeset release PR body (via RELEASE_PR_BODY env var or stdin).
 *     By the time this runs, the PR body has already been enhanced by enhance-release-pr.mjs
 *     to include server changes, deduplication, and categorization. The .server-changes/ files
 *     themselves are already deleted (consumed on the release branch, same as .changeset/ files).
 *   - Git log for contributor info
 *
 * Outputs the formatted GitHub release body to stdout.
 */

import { execSync } from "child_process";
import { join } from "path";

const version = process.argv[2];
if (!version) {
  console.error("Usage: node scripts/generate-github-release.mjs <version>");
  process.exit(1);
}

const ROOT_DIR = join(import.meta.dirname, "..");

// --- Parse the enhanced PR body ---
// The PR body from enhance-release-pr.mjs has sections like:
//   ## Highlights
//   ## Improvements
//   ## Bug fixes
//   ## Server changes
//   ## Breaking changes
//   <details>...</details>
// We extract the content between the first heading and the <details> block.

function extractChangesFromPrBody(body) {
  if (!body) return "";

  const lines = body.split("\n");
  const outputLines = [];
  let inDetails = false;
  let foundContent = false;

  for (const line of lines) {
    // Skip the title line (# trigger.dev vX.Y.Z) and Summary section
    if (line.startsWith("# trigger.dev v")) continue;
    if (line.startsWith("## Summary")) {
      // Skip the summary line and its content (next non-empty line)
      continue;
    }

    // Stop before raw changeset output
    if (line.trim() === "<details>") {
      inDetails = true;
      continue;
    }
    if (inDetails) continue;

    // Collect everything from the first ## heading onward
    if (line.startsWith("## ") && !foundContent) {
      foundContent = true;
    }

    if (foundContent) {
      outputLines.push(line);
    }
  }

  return outputLines.join("\n").trim();
}

// --- Get contributors from git log ---

function getContributors(previousVersion) {
  try {
    const range = previousVersion
      ? `v${previousVersion}...HEAD`
      : "HEAD~50..HEAD";
    const log = execSync(`git log ${range} --format="%aN|%aE" --no-merges`, {
      cwd: ROOT_DIR,
      encoding: "utf-8",
    });

    const contributors = new Map();
    for (const line of log.split("\n").filter(Boolean)) {
      const [name, email] = line.split("|");
      if (!name || email?.includes("noreply.github.com")) {
        // Try to extract username from noreply email
        const match = email?.match(/(\d+\+)?(.+)@users\.noreply\.github\.com/);
        if (match) {
          const username = match[2];
          contributors.set(username, (contributors.get(username) || 0) + 1);
        }
        continue;
      }
      contributors.set(name, (contributors.get(name) || 0) + 1);
    }

    return [...contributors.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
  } catch {
    return [];
  }
}

// --- Get published packages ---

function getPublishedPackages() {
  try {
    const config = JSON.parse(
      execSync("cat .changeset/config.json", {
        cwd: ROOT_DIR,
        encoding: "utf-8",
      })
    );
    const fixed = config.fixed?.[0] || [];
    return fixed;
  } catch {
    return [
      "@trigger.dev/sdk",
      "@trigger.dev/core",
      "@trigger.dev/build",
      "trigger.dev",
    ];
  }
}

function getPreviousVersion(version) {
  const parts = version.split(".").map(Number);
  if (parts[2] > 0) {
    parts[2]--;
  } else if (parts[1] > 0) {
    parts[1]--;
    parts[2] = 0;
  }
  return parts.join(".");
}

// --- Format the release body ---

function formatRelease({ version, changesContent, contributors, packages }) {
  const lines = [];

  lines.push(`# trigger.dev v${version}`);
  lines.push("");
  lines.push("## Upgrade");
  lines.push("");
  lines.push("```sh");
  lines.push("npx trigger.dev@latest update  # npm");
  lines.push("pnpm dlx trigger.dev@latest update  # pnpm");
  lines.push("yarn dlx trigger.dev@latest update  # yarn");
  lines.push("bunx trigger.dev@latest update  # bun");
  lines.push("```");
  lines.push("");
  // The Docker image link initially points to the container page without a tag filter.
  // After Docker images are built, the update-release job patches this with the exact tag URL.
  lines.push(
    `Self-hosted Docker image: [\`ghcr.io/triggerdotdev/trigger.dev:v${version}\`](https://github.com/triggerdotdev/trigger.dev/pkgs/container/trigger.dev)`
  );
  lines.push("");
  lines.push("## Release notes");
  lines.push("");
  lines.push(
    `Read the full release notes: https://trigger.dev/changelog/v${version.replace(/\./g, "-")}`
  );
  lines.push("");

  // What's changed — extracted from the enhanced PR body
  if (changesContent) {
    lines.push("## What's changed");
    lines.push("");
    lines.push(changesContent);
    lines.push("");
  }

  // Packages
  if (packages.length > 0) {
    lines.push(`## All packages: v${version}`);
    lines.push("");
    lines.push(packages.join(", "));
    lines.push("");
  }

  // Contributors
  if (contributors.length > 0) {
    lines.push("## Contributors");
    lines.push("");
    lines.push(contributors.map((c) => `@${c}`).join(", "));
    lines.push("");
  }

  // Comparison link
  const prevVersion = getPreviousVersion(version);
  if (prevVersion) {
    lines.push(
      `**Full changelog**: https://github.com/triggerdotdev/trigger.dev/compare/v${prevVersion}...v${version}`
    );
  }

  return lines.join("\n");
}

// --- Main ---

async function main() {
  // Read PR body from env or stdin
  let prBody = process.env.RELEASE_PR_BODY || "";
  if (!prBody && !process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    prBody = Buffer.concat(chunks).toString("utf-8");
  }

  const changesContent = extractChangesFromPrBody(prBody);
  const contributors = getContributors(getPreviousVersion(version));
  const packages = getPublishedPackages();

  const body = formatRelease({
    version,
    changesContent,
    contributors,
    packages,
  });

  process.stdout.write(body);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
