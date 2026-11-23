import type { Prisma, RuntimeEnvironmentType } from "@trigger.dev/database";
import { GitMeta } from "@trigger.dev/core/v3";
import { $replica } from "~/db.server";
import { versionStanding } from "~/utils/versionLabel";
import { findCurrentVersion } from "~/v3/models/workerDeployment.server";
import { processGitMetadata } from "./BranchesPresenter.server";

type Env = { id: string; type: RuntimeEnvironmentType; projectId: string };

type Person = { name: string | null; avatarUrl: string | null };

/** How a version arrived: the commit and who shipped it for a deploy, the dev owner for `trigger dev`. */
export type VersionSource = {
  kind: "deploy" | "dev";
  /** "CLI", "GitHub", "GitHub Actions"; unused for dev. */
  via: string;
  commitMessage: string | null;
  branch: string | null;
  shortSha: string | null;
  dirty: boolean;
  commitUrl: string | null;
  branchUrl: string | null;
  author: Person | null;
  /** Deploy start to deployed, for finished deploys. */
  buildMs: number | null;
  at: Date;
};

type DeploymentForSource = {
  git: Prisma.JsonValue;
  triggeredVia: string | null;
  createdAt: Date;
  startedAt: Date | null;
  deployedAt: Date | null;
  failedAt: Date | null;
  triggeredBy: { name: string | null; displayName: string | null; avatarUrl: string | null } | null;
};

function deploySource(d: DeploymentForSource): VersionSource {
  // Read the raw git JSON: deploys from a repo with no remote have a commit but no links.
  const git = GitMeta.safeParse(d.git ?? {});
  const g = git.success ? git.data : undefined;
  const links = processGitMetadata(d.git);
  const via =
    d.triggeredVia === "git_integration:github" || g?.source === "trigger_github_app"
      ? "GitHub"
      : g?.source === "github_actions"
        ? "GitHub Actions"
        : "CLI";
  const author: Person | null = g?.ghUsername
    ? { name: g.ghUsername, avatarUrl: g.ghUserAvatarUrl ?? null }
    : d.triggeredBy
      ? {
          name: d.triggeredBy.name ?? d.triggeredBy.displayName ?? null,
          avatarUrl: d.triggeredBy.avatarUrl,
        }
      : g?.commitAuthorName
        ? { name: g.commitAuthorName, avatarUrl: null }
        : null;
  const start = d.startedAt ?? d.createdAt;
  return {
    kind: "deploy",
    via,
    commitMessage: g?.commitMessage?.split("\n")[0] ?? null,
    branch: g?.commitRef ?? null,
    shortSha: g?.commitSha?.slice(0, 7) ?? null,
    dirty: g?.dirty ?? false,
    commitUrl: links?.commitUrl ?? null,
    branchUrl: links?.branchUrl ?? null,
    author,
    buildMs: d.deployedAt ? d.deployedAt.getTime() - start.getTime() : null,
    at: d.deployedAt ?? d.failedAt ?? d.createdAt,
  };
}

/** A dev environment belongs to one org member; their `trigger dev` builds its versions. */
async function devSource(env: Env, createdAt: Date): Promise<VersionSource> {
  const row = await $replica.runtimeEnvironment.findFirst({
    where: { id: env.id },
    select: {
      branchName: true,
      orgMember: {
        select: { user: { select: { name: true, displayName: true, avatarUrl: true } } },
      },
    },
  });
  const user = row?.orgMember?.user;
  return {
    kind: "dev",
    via: "trigger dev",
    commitMessage: null,
    branch: row?.branchName ?? null,
    shortSha: null,
    dirty: false,
    commitUrl: null,
    branchUrl: null,
    author: user
      ? { name: user.name ?? user.displayName ?? null, avatarUrl: user.avatarUrl }
      : null,
    buildMs: null,
    at: createdAt,
  };
}

/** One version's summary for the version label's popover. */
export async function findVersion(env: Env, version: string) {
  const [worker, deployment, currentVersion] = await Promise.all([
    $replica.backgroundWorker.findFirst({
      // projectId makes this a lookup on the unique (projectId, runtimeEnvironmentId, version)
      // index. Without it Postgres walks the environment's workers looking for the version.
      where: { projectId: env.projectId, runtimeEnvironmentId: env.id, version },
      select: {
        createdAt: true,
        sdkVersion: true,
        cliVersion: true,
        tasks: { select: { slug: true } },
      },
    }),
    env.type === "DEVELOPMENT"
      ? null
      : $replica.workerDeployment.findFirst({
          where: { environmentId: env.id, version },
          select: {
            shortCode: true,
            status: true,
            git: true,
            triggeredVia: true,
            createdAt: true,
            startedAt: true,
            deployedAt: true,
            failedAt: true,
            triggeredBy: { select: { name: true, displayName: true, avatarUrl: true } },
          },
        }),
    findCurrentVersion(env, $replica),
  ]);

  if (!worker && !deployment) return null;

  const previous = worker
    ? await $replica.backgroundWorker.findFirst({
        where: { runtimeEnvironmentId: env.id, createdAt: { lt: worker.createdAt } },
        orderBy: { createdAt: "desc" },
        select: { version: true, tasks: { select: { slug: true } } },
      })
    : null;

  const slugs = worker?.tasks.map((t) => t.slug) ?? [];
  const previousSlugs = previous?.tasks.map((t) => t.slug);
  const createdAt = worker?.createdAt ?? deployment!.createdAt;

  return {
    version,
    standing: versionStanding(version, currentVersion),
    currentVersion: currentVersion ?? null,
    tasksCount: slugs.length,
    added: previousSlugs ? slugs.filter((s) => !previousSlugs.includes(s)).sort() : [],
    removed: previousSlugs ? previousSlugs.filter((s) => !slugs.includes(s)).sort() : [],
    previousVersion: previous?.version ?? null,
    sdkVersion: worker?.sdkVersion ?? null,
    cliVersion: worker?.cliVersion ?? null,
    source: deployment ? deploySource(deployment) : await devSource(env, createdAt),
    deployment: deployment ? { shortCode: deployment.shortCode, status: deployment.status } : null,
  };
}

export type VersionDetail = NonNullable<Awaited<ReturnType<typeof findVersion>>>;
