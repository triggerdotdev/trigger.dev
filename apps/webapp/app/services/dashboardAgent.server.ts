import { signUserActorToken } from "@trigger.dev/rbac";
import { TriggerClient } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { githubApp } from "./gitHub.server";
import { logger } from "./logger.server";

const TASK_ID = "dashboard-agent";

// Read-only cap on the agent's delegated user-actor token. `read:apiKeys` is
// what lets it exchange the token for an env JWT (the gate on the exchange
// route); the rest scope the actual reads. No write/admin scopes, so even a
// leaked token can't mutate anything.
const DASHBOARD_AGENT_UAT_CAP = [
  "read:apiKeys",
  "read:runs",
  "read:deployments",
  "read:environments",
  "read:errors",
  "read:query",
];

// Minted fresh on every turn (the `in` proxy injects it), so the lifetime only
// has to cover a single turn's tool calls. Short by design — a stale token in
// the agent's run payload expires quickly.
const DASHBOARD_AGENT_UAT_TTL_SECONDS = 10 * 60;

// The Trigger instance this webapp runs against — the same origin the agent
// task calls back to (as the user) for its read tools.
export function dashboardAgentApiOrigin(): string {
  return env.API_ORIGIN ?? env.APP_ORIGIN;
}

// Mint a short-lived, read-only delegated token for the signed-in user. Self
// service from the dashboard session (never a PAT), so a user can only ever
// mint a token for themselves. The `in` proxy injects this into the turn's
// metadata so the token reaches the agent without ever touching the browser.
export function mintDashboardAgentUserActorToken(userId: string): Promise<string> {
  return signUserActorToken(env.SESSION_SECRET, {
    userId,
    client: "dashboard-agent",
    cap: DASHBOARD_AGENT_UAT_CAP,
    expirationTime: Math.floor(Date.now() / 1000) + DASHBOARD_AGENT_UAT_TTL_SECONDS,
  });
}

// The session is created in whatever env DASHBOARD_AGENT_SECRET_KEY belongs to.
// baseURL is the Trigger instance this webapp runs against (its own API origin).
function dashboardAgentConfig() {
  const accessToken = env.DASHBOARD_AGENT_SECRET_KEY;
  if (!accessToken) return null;
  return { baseURL: dashboardAgentApiOrigin(), accessToken };
}

export function isDashboardAgentConfigured(): boolean {
  return Boolean(env.DASHBOARD_AGENT_SECRET_KEY);
}

export async function startDashboardAgentSession(params: {
  chatId: string;
  clientData?: Record<string, unknown>;
}): Promise<{ publicAccessToken: string }> {
  const config = dashboardAgentConfig();
  if (!config) throw new Error("DASHBOARD_AGENT_SECRET_KEY is not set");
  const startSession = chat.createStartSessionAction(TASK_ID, { apiClient: config });
  return startSession({ chatId: params.chatId, clientData: params.clientData });
}

export async function mintDashboardAgentToken(chatId: string): Promise<string> {
  const config = dashboardAgentConfig();
  if (!config) throw new Error("DASHBOARD_AGENT_SECRET_KEY is not set");
  const client = new TriggerClient(config);
  return client.auth.createPublicToken({
    scopes: { read: { sessions: chatId }, write: { sessions: chatId } },
    expirationTime: "1h",
  });
}

// A signed, short-lived pointer to the project's connected repo at a commit. Only
// the URL crosses to the agent; the GitHub token stays here. The agent's code
// tools download + extract it on their own filesystem (see @internal/dashboard-agent).
export type DashboardAgentRepoSnapshot = {
  tarballUrl: string;
  owner: string;
  repo: string;
  sha: string;
  defaultBranch?: string;
};

// The GitHub archive redirect URL is valid for a few minutes; cache the resolved
// pointer briefly so multi-turn chats don't re-mint a token + re-resolve on every
// message. Keyed by project + ref.
const repoSnapshotCache = new Map<string, { snapshot: DashboardAgentRepoSnapshot; expiresAt: number }>();
const REPO_SNAPSHOT_TTL_MS = 60_000;

/**
 * Resolve the code-mode repo snapshot for a project, or null when the GitHub App
 * is disabled / no repo is connected (which keeps the agent in assistant mode).
 *
 * Mints a `contents:read` installation token scoped to the one repo, resolves the
 * signed archive URL, and returns just that URL. The token never leaves the
 * server. `opts.ref` pins a specific commit (run-SHA pinning); without it, the
 * tracked prod branch (or the repo default) head is used.
 */
export async function resolveDashboardAgentRepoSnapshot(
  projectId: string,
  opts: { ref?: string } = {}
): Promise<DashboardAgentRepoSnapshot | null> {
  if (!githubApp) return null;

  // Cache per project + ref so HEAD and each pinned commit are cached separately.
  const cacheKey = `${projectId}:${opts.ref ?? "HEAD"}`;
  const cached = repoSnapshotCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.snapshot;

  const connected = await prisma.connectedGithubRepository.findFirst({
    where: { projectId },
    select: {
      branchTracking: true,
      repository: {
        select: {
          fullName: true,
          defaultBranch: true,
          installation: { select: { appInstallationId: true } },
        },
      },
    },
  });
  if (!connected) return null;

  const [owner, repo] = connected.repository.fullName.split("/");
  if (!owner || !repo) return null;
  const installationId = Number(connected.repository.installation.appInstallationId);
  const defaultBranch = connected.repository.defaultBranch;
  const tracking = connected.branchTracking as { prod?: { branch?: string } } | null;
  // An explicit 40-char commit SHA is used directly (run-SHA pinning); otherwise
  // resolve the requested branch, the tracked prod branch, or the repo default.
  const requested = opts.ref;
  const isSha = !!requested && /^[0-9a-f]{40}$/i.test(requested);
  const branchRef = requested && !isSha ? requested : tracking?.prod?.branch || defaultBranch;

  try {
    const octokit = await githubApp.getInstallationOctokit(installationId);
    const sha = isSha
      ? requested!
      : (await octokit.rest.repos.getBranch({ owner, repo, branch: branchRef })).data.commit.sha;

    const token = await githubApp.octokit.rest.apps.createInstallationAccessToken({
      installation_id: installationId,
      repositories: [repo],
      permissions: { contents: "read" },
    });

    // Resolve the signed archive URL without downloading the bytes server-side.
    const redirect = await fetch(`https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`, {
      headers: {
        Authorization: `Bearer ${token.data.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "trigger-dashboard-agent",
      },
      redirect: "manual",
    });
    const tarballUrl = redirect.headers.get("location");
    if (!tarballUrl) return null;

    const snapshot: DashboardAgentRepoSnapshot = { tarballUrl, owner, repo, sha, defaultBranch };
    repoSnapshotCache.set(cacheKey, { snapshot, expiresAt: Date.now() + REPO_SNAPSHOT_TTL_MS });
    return snapshot;
  } catch (error) {
    logger.error("Failed to resolve dashboard agent repo snapshot", { error, projectId });
    return null;
  }
}

// Map a run (by friendly id) to the commit its deployed version came from, for
// run-SHA pinning. A run locks to a BackgroundWorker (`lockedToVersionId`), whose
// WorkerDeployment carries the commit. Null for runs with no deployed version
// (e.g. dev runs), so the agent falls back to the branch head.
export async function resolveRunCommit(
  environmentId: string,
  runFriendlyId: string
): Promise<{ sha: string; version: string; dirty: boolean } | null> {
  const run = await prisma.taskRun.findFirst({
    where: { friendlyId: runFriendlyId, runtimeEnvironmentId: environmentId },
    select: { lockedToVersionId: true },
  });
  if (!run?.lockedToVersionId) return null;

  const deployment = await prisma.workerDeployment.findFirst({
    where: { workerId: run.lockedToVersionId },
    select: { commitSHA: true, version: true, git: true },
  });
  if (!deployment?.commitSHA) return null;

  const dirty = (deployment.git as { dirty?: boolean } | null)?.dirty ?? false;
  return { sha: deployment.commitSHA, version: deployment.version, dirty };
}
