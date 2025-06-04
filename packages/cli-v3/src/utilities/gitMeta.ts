import fs from "fs/promises";
import { join } from "path";
import ini from "ini";
import git from "git-last-commit";
import { x } from "tinyexec";
import { GitMeta } from "@trigger.dev/core/v3";

export async function createGitMeta(directory: string): Promise<GitMeta | undefined> {
  // First try to get metadata from GitHub Actions environment
  const githubMeta = await getGitHubActionsMeta();
  if (githubMeta) {
    return githubMeta;
  }

  // Fall back to git commands for local development
  const remoteUrl = await getOriginUrl(join(directory, ".git/config"));

  const [commitResult, dirtyResult] = await Promise.allSettled([
    getLastCommit(directory),
    isDirty(directory),
  ]);

  if (commitResult.status === "rejected") {
    return;
  }

  if (dirtyResult.status === "rejected") {
    return;
  }

  const dirty = dirtyResult.value;
  const commit = commitResult.value;

  // Get the pull request number from process.env (GitHub Actions)
  const pullRequestNumber: number | undefined = process.env.GITHUB_PULL_REQUEST_NUMBER
    ? parseInt(process.env.GITHUB_PULL_REQUEST_NUMBER)
    : undefined;

  return {
    remoteUrl: remoteUrl ?? undefined,
    commitAuthorName: commit.author.name,
    commitMessage: commit.subject,
    commitRef: commit.branch,
    commitSha: commit.hash,
    dirty,
    pullRequestNumber,
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

async function isDirty(directory: string): Promise<boolean> {
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

async function parseGitConfig(configPath: string) {
  try {
    return ini.parse(await fs.readFile(configPath, "utf8"));
  } catch (err: unknown) {
    return;
  }
}

function pluckRemoteUrls(gitConfig: { [key: string]: any }): { [key: string]: string } | undefined {
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

function pluckOriginUrl(gitConfig: { [key: string]: any }): string | undefined {
  // Assuming "origin" is the remote url that the user would want to use
  return gitConfig['remote "origin"']?.url;
}

async function getOriginUrl(configPath: string): Promise<string | null> {
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

function isGitHubActions(): boolean {
  return process.env.GITHUB_ACTIONS === "true";
}

async function getGitHubActionsMeta(): Promise<GitMeta | undefined> {
  if (!isGitHubActions()) {
    return undefined;
  }

  // Required fields that should always be present in GitHub Actions
  if (!process.env.GITHUB_SHA || !process.env.GITHUB_REF) {
    return undefined;
  }

  const remoteUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}.git`
      : undefined;

  let commitRef = process.env.GITHUB_REF;
  let commitMessage: string | undefined;
  let pullRequestNumber: number | undefined;
  let pullRequestTitle: string | undefined;
  let pullRequestState: "open" | "closed" | "merged" | undefined;
  let commitSha = process.env.GITHUB_SHA;

  if (process.env.GITHUB_EVENT_PATH) {
    try {
      const eventData = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, "utf8"));

      if (process.env.GITHUB_EVENT_NAME === "push") {
        commitMessage = eventData.head_commit?.message;
        // For push events, GITHUB_REF will be like "refs/heads/main"
        commitRef = process.env.GITHUB_REF.replace(/^refs\/(heads|tags)\//, "");
      } else if (process.env.GITHUB_EVENT_NAME === "pull_request") {
        // For PRs, use the head commit info
        pullRequestTitle = eventData.pull_request?.title;
        commitRef = eventData.pull_request?.head?.ref;
        pullRequestNumber = eventData.pull_request?.number;
        commitSha = eventData.pull_request?.head?.sha;
        pullRequestState = eventData.pull_request?.state as "open" | "closed";

        // Check if PR was merged
        if (pullRequestState === "closed" && eventData.pull_request?.merged === true) {
          pullRequestState = "merged";
        }

        await x("git", ["status"], {
          nodeOptions: {
            cwd: process.cwd(),
          },
        }).then((result) => console.debug(result.stdout));

        commitMessage = await getCommitMessage(process.cwd(), commitSha, pullRequestNumber);
      }
    } catch (error) {
      console.debug("Failed to parse GitHub event payload:", errorToString(error));
    }
  } else {
    console.debug("No GITHUB_EVENT_PATH found");
    // If we can't read the event payload, at least try to clean up the ref
    commitRef = process.env.GITHUB_REF.replace(/^refs\/(heads|tags)\//, "");
  }

  return {
    remoteUrl,
    commitSha,
    commitRef,
    // In CI, the workspace is always clean
    dirty: false,
    // These fields might not be available in all GitHub Actions contexts
    commitAuthorName: process.env.GITHUB_ACTOR,
    commitMessage,
    pullRequestNumber:
      pullRequestNumber ??
      (process.env.GITHUB_PULL_REQUEST_NUMBER
        ? parseInt(process.env.GITHUB_PULL_REQUEST_NUMBER)
        : undefined),
    pullRequestTitle,
    pullRequestState,
  };
}

async function getCommitMessage(
  directory: string,
  sha: string,
  prNumber?: number
): Promise<string | undefined> {
  try {
    // First try to fetch the specific commit
    await x("git", ["fetch", "origin", sha], {
      nodeOptions: {
        cwd: directory,
      },
    });

    // Try to get the commit message
    const result = await x("git", ["log", "-1", "--format=%B", sha], {
      nodeOptions: {
        cwd: directory,
      },
    });

    const message = result.stdout.trim();

    if (!message && prNumber) {
      // If that didn't work, try fetching the PR branch
      const branchResult = await x(
        "git",
        ["fetch", "origin", `pull/${prNumber}/head:pr-${prNumber}`],
        {
          nodeOptions: {
            cwd: directory,
          },
        }
      );

      // Try again with the fetched branch
      const branchCommitResult = await x("git", ["log", "-1", "--format=%B", `pr-${prNumber}`], {
        nodeOptions: {
          cwd: directory,
        },
      });
      return branchCommitResult.stdout.trim();
    }

    return message;
  } catch (error) {
    console.debug("Error getting commit message:", errorToString(error));
    return undefined;
  }
}
