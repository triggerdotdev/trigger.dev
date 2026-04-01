import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import { logger } from "@trigger.dev/sdk";

const execFileAsync = promisify(execFile);

// #region git helper
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024, // 10MB for large diffs
    timeout: 30_000,
  });
  return stdout.trim();
}
// #endregion

// #region GitHub API helper
export async function githubApi<T>(path: string, token?: string | null): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json() as Promise<T>;
}
// #endregion

// #region URL parser
export function parseGitHubUrl(url: string): { owner: string; repo: string } {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) throw new Error(`Invalid GitHub URL: ${url}`);
  return { owner: match[1]!, repo: match[2]!.replace(/\.git$/, "") };
}
// #endregion

// #region Clone repo
export async function cloneRepo({
  owner,
  repo,
  clonePath,
  token,
}: {
  owner: string;
  repo: string;
  clonePath: string;
  token?: string | null;
}): Promise<void> {
  const cloneUrl = token
    ? `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
    : `https://github.com/${owner}/${repo}.git`;

  logger.info("Cloning repo", { owner, repo, clonePath });

  await execFileAsync("git", ["clone", "--depth=1", cloneUrl, clonePath], {
    timeout: 60_000,
  });
}
// #endregion

// #region Cleanup
export async function cleanupClone(clonePath: string | undefined): Promise<void> {
  if (!clonePath) return;
  try {
    await rm(clonePath, { recursive: true, force: true });
    logger.info("Cleaned up clone directory", { clonePath });
  } catch {
    /* best-effort */
  }
}
// #endregion
