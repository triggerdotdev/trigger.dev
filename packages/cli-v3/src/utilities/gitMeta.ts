import fs from "fs/promises";
import { join } from "path";
import ini from "ini";
import git from "git-last-commit";
import { x } from "tinyexec";
import { GitMeta } from "@trigger.dev/core/v3";

export async function createGitMeta(directory: string): Promise<GitMeta | undefined> {
  if (isGitHubApp()) {
    return getGitHubAppMeta();
  }

  if (isGitHubActions()) {
    return getGitHubActionsMeta();
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

  return {
    source: "local",
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

function isGitHubActions() {
  // GH Actions CI sets these env variables
  return (
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.GITHUB_SHA !== undefined &&
    process.env.GITHUB_REF !== undefined
  );
}

async function getGitHubActionsMeta(): Promise<GitMeta> {
  const remoteUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}.git`
      : undefined;

  // GITHUB_SHA and GITHUB_REF are both set in GH Actions CI
  const githubSha = process.env.GITHUB_SHA ?? "";
  const githubRef = process.env.GITHUB_REF ?? "";

  // For push events, GITHUB_REF is fully qualified, e.g., "refs/heads/main"
  let commitRef = githubRef.replace(/^refs\/(heads|tags)\//, "");
  let commitMessage: string | undefined;
  let commitSha = githubSha;
  let pullRequestNumber: number | undefined;
  let pullRequestTitle: string | undefined;
  let pullRequestState: "open" | "closed" | "merged" | undefined;

  if (process.env.GITHUB_EVENT_PATH) {
    try {
      const eventData = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, "utf8"));

      if (process.env.GITHUB_EVENT_NAME === "push") {
        commitMessage = eventData.head_commit?.message;
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
  }

  return {
    provider: "github",
    source: "github_actions",
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

function isGitHubApp() {
  // we set this env variable in our build server
  return process.env.TRIGGER_GITHUB_APP === "true";
}

function getGitHubAppMeta(): GitMeta {
  return {
    provider: "github",
    source: "trigger_github_app",
    remoteUrl: process.env.GITHUB_REPOSITORY_URL,
    commitSha: process.env.GITHUB_HEAD_COMMIT_SHA,
    commitRef: process.env.GITHUB_REF?.replace(/^refs\/(heads|tags)\//, ""),
    commitMessage: process.env.GITHUB_HEAD_COMMIT_MESSAGE,
    commitAuthorName: process.env.GITHUB_HEAD_COMMIT_AUTHOR_NAME,
    pullRequestNumber: process.env.GITHUB_PULL_REQUEST_NUMBER
      ? parseInt(process.env.GITHUB_PULL_REQUEST_NUMBER)
      : undefined,
    pullRequestTitle: process.env.GITHUB_PULL_REQUEST_TITLE,
    pullRequestState: process.env.GITHUB_PULL_REQUEST_STATE as
      | "open"
      | "closed"
      | "merged"
      | undefined,
    // the workspace is always clean as we clone the repo in the build server
    dirty: false,
    ghUsername: process.env.GITHUB_USERNAME,
    ghUserAvatarUrl: process.env.GITHUB_USER_AVATAR_URL,
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
