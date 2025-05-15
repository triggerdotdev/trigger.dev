import fs from "fs/promises";
import { join } from "path";
import ini from "ini";
import git from "git-last-commit";
import { x } from "tinyexec";
import { logger } from "../utilities/logger.js";
import { GitMeta } from "@trigger.dev/core/v3";

export async function createGitMeta(directory: string): Promise<GitMeta | undefined> {
  const remoteUrl = await getOriginUrl(join(directory, ".git/config"));

  const [commitResult, dirtyResult] = await Promise.allSettled([
    getLastCommit(directory),
    isDirty(directory),
  ]);

  if (commitResult.status === "rejected") {
    logger.debug(
      `Failed to get last commit. The directory is likely not a Git repo, there are no latest commits, or it is corrupted.\n${commitResult.reason}`
    );
    return;
  }

  if (dirtyResult.status === "rejected") {
    logger.debug(`Failed to determine if Git repo has been modified:\n${dirtyResult.reason}`);
    return;
  }

  const dirty = dirtyResult.value;
  const commit = commitResult.value;

  return {
    remoteUrl: remoteUrl ?? undefined,
    commitAuthorName: commit.author.name,
    commitMessage: commit.subject,
    commitRef: commit.branch,
    commitSha: commit.hash,
    dirty,
  };
}

function getLastCommit(directory: string): Promise<git.Commit> {
  return new Promise((resolve, reject) => {
    git.getLastCommit(
      (err, commit) => {
        if (err) {
          return reject(err);
        }

        resolve(commit);
      },
      { dst: directory }
    );
  });
}

export async function isDirty(directory: string): Promise<boolean> {
  try {
    const result = await x("git", ["--no-optional-locks", "status", "-s"], {
      nodeOptions: {
        cwd: directory,
      },
    });

    // Example output (when dirty):
    //    M ../fs-detectors/src/index.ts
    return result.stdout.trim().length > 0;
  } catch (error) {
    throw error;
  }
}

export async function parseGitConfig(configPath: string) {
  try {
    return ini.parse(await fs.readFile(configPath, "utf8"));
  } catch (err: unknown) {
    logger.debug(`Error while parsing repo data: ${errorToString(err)}`);
    return;
  }
}

export function pluckRemoteUrls(gitConfig: {
  [key: string]: any;
}): { [key: string]: string } | undefined {
  const remoteUrls: { [key: string]: string } = {};

  for (const key of Object.keys(gitConfig)) {
    if (key.includes("remote")) {
      // ex. remote "origin" — matches origin
      const remoteName = key.match(/(?<=").*(?=")/g)?.[0];
      const remoteUrl = gitConfig[key]?.url;
      if (remoteName && remoteUrl) {
        remoteUrls[remoteName] = remoteUrl;
      }
    }
  }

  if (Object.keys(remoteUrls).length === 0) {
    return;
  }

  return remoteUrls;
}

export async function getRemoteUrls(
  configPath: string
): Promise<{ [key: string]: string } | undefined> {
  const config = await parseGitConfig(configPath);
  if (!config) {
    return;
  }

  const remoteUrls = pluckRemoteUrls(config);
  return remoteUrls;
}

export function pluckOriginUrl(gitConfig: { [key: string]: any }): string | undefined {
  // Assuming "origin" is the remote url that the user would want to use
  return gitConfig['remote "origin"']?.url;
}

export async function getOriginUrl(configPath: string): Promise<string | null> {
  const gitConfig = await parseGitConfig(configPath);
  if (!gitConfig) {
    return null;
  }

  const originUrl = pluckOriginUrl(gitConfig);
  if (originUrl) {
    return originUrl;
  }
  return null;
}

function errorToString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
