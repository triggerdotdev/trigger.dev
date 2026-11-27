import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import { boundedIn } from "@trigger.dev/database";
import { $replica } from "~/db.server";
import { BranchesPresenter } from "~/presenters/v3/BranchesPresenter.server";
import { type Region, RegionsPresenter } from "~/presenters/v3/RegionsPresenter.server";
import { logger } from "~/services/logger.server";
import { NO_BRANCH_LIMIT } from "~/services/upsertBranch.server";
import { isBranchableEnvironment } from "~/utils/branchableEnvironment";
import { sortEnvironments } from "~/utils/environmentSort";
import { resolveMcpSubject } from "../gate/resolveSubject.server";
import type { McpToolContext } from "../gate/types";
import type { McpIdentity } from "../types";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, textResult } from "./define.server";
import { agentFence, describeDeploymentForAgent } from "./format/environments";
import { plainError } from "./format/insights";
import { startReadBudget } from "./readBudget.server";
import { ListBranchesInput, ListEnvironmentsInput, ListRegionsInput } from "./schemas/environments";

const READ_BUDGET_MS = 10_000;
const SLUG = /^[a-z0-9-]{1,64}$/;
const REGION_NAME = /^[a-z0-9-]{1,64}$/;

const PROJECT_NOT_FOUND = "Project not found. Use list_projects to see your projects.";
export const READ_TIMED_OUT = "Reading this took too long. Try again.";
export const READ_CANCELLED = "The request was cancelled before the read finished.";
export const REGIONS_NOT_AVAILABLE = "Regions are not available on this server.";
const READ_FAILED = "The tool failed. Try again later.";

type Budget = ReturnType<typeof startReadBudget>;
type Stopped = { ok: false; reason: "timeout" | "aborted" };

const stoppedResult = ({ reason }: Stopped) =>
  plainError(reason === "timeout" ? READ_TIMED_OUT : READ_CANCELLED);

const plain = (value: string, pattern: RegExp, source: string) =>
  pattern.test(value) ? value : agentFence(value, source);

const isoDate = (date: Date | null | undefined) => (date ? date.toISOString() : undefined);

async function findProject(ctx: McpToolContext) {
  if (!ctx.subject?.projectId) return null;
  return $replica.project.findFirst({
    where: { id: ctx.subject.projectId, deletedAt: null },
    select: { slug: true, defaultWorkerGroupId: true },
  });
}

const SHOWN_NAMES = 10;
const namesList = (names: string[], source: string) =>
  names
    .slice(0, SHOWN_NAMES)
    .map((name) => agentFence(name, source))
    .join(", ") + (names.length > SHOWN_NAMES ? ` (+${names.length - SHOWN_NAMES} more)` : "");

/** Without a preview environment a preview call still resolves to the project, so the tool can say so. */
export async function branchesSubject(args: unknown, identity: McpIdentity) {
  const subject = await resolveMcpSubject(args, identity);
  if (subject || (args as { environment?: unknown } | null)?.environment !== "preview") {
    return subject;
  }
  return resolveMcpSubject({ ...(args as object), environment: undefined }, identity);
}

export type EnvironmentsReadDeps = {
  readBudgetMs: number;
  isDevConnected: (environmentId: string) => Promise<boolean>;
};

const defaultDeps: EnvironmentsReadDeps = {
  readBudgetMs: READ_BUDGET_MS,
  isDevConnected: async (environmentId) => {
    const { devPresence } = await import("~/presenters/v3/DevPresence.server");
    return devPresence.isConnected(environmentId);
  },
};

async function readEnvironments(ctx: McpToolContext, deps: EnvironmentsReadDeps, budget: Budget) {
  const projectId = ctx.subject!.projectId!;
  const canReadBranches = !!ctx.ability?.can("read", { type: "branches", envType: "PREVIEW" });
  const found = await budget.read(() =>
    $replica.runtimeEnvironment.findMany({
      where: {
        projectId,
        archivedAt: null,
        parentEnvironmentId: null,
        OR: [
          { type: { in: ["STAGING", "PRODUCTION", "PREVIEW"] } },
          { type: "DEVELOPMENT", orgMember: { userId: ctx.identity.userId } },
        ],
      },
      select: {
        id: true,
        slug: true,
        type: true,
        isBranchableEnvironment: true,
        parentEnvironmentId: true,
        branchName: true,
        paused: true,
        previewAutoArchiveAfterDays: canReadBranches,
        previewAutoArchiveExcludedBranches: canReadBranches,
      },
    })
  );
  if (!found.ok) return found;
  const environments = found.value;

  const readable = environments.filter((environment) =>
    ctx.ability?.can("read", { type: "deployments", envType: environment.type })
  );
  const promotions = await budget.read(() =>
    $replica.workerDeploymentPromotion.findMany({
      where: {
        environmentId: { in: boundedIn(readable.map(({ id }) => id)) },
        label: CURRENT_DEPLOYMENT_LABEL,
      },
      select: { environmentId: true, deployment: { select: { version: true, shortCode: true } } },
    })
  );
  if (!promotions.ok) return promotions;
  const current = new Map(promotions.value.map((p) => [p.environmentId, p.deployment]));

  const dev = environments.find((environment) => environment.type === "DEVELOPMENT");
  const connected = dev
    ? await budget.read(() =>
        deps.isDevConnected(dev.id).catch((error: unknown) => {
          logger.error("mcp.tool failed", {
            tool: "list_environments",
            error: `list_environments: ${error instanceof Error ? error.message : String(error)}`,
          });
          return "unknown" as const;
        })
      )
    : ({ ok: true, value: undefined } as const);
  if (!connected.ok) return connected;

  return {
    ok: true as const,
    value: {
      environments: sortEnvironments(environments),
      readable,
      canReadBranches,
      current,
      devConnected: connected.value,
    },
  };
}

type EnvironmentsData = Extract<
  Awaited<ReturnType<typeof readEnvironments>>,
  { ok: true }
>["value"];

function renderEnvironments(data: EnvironmentsData) {
  const lines = [
    `Found ${data.environments.length} environment${data.environments.length === 1 ? "" : "s"}`,
    "",
  ];
  const readable = new Set(data.readable.map(({ id }) => id));
  for (const environment of data.environments) {
    const parts = [`- ${plain(environment.slug, SLUG, "environment-slug")} (${environment.type})`];
    if (environment.paused) parts.push("paused");
    if (environment.type === "DEVELOPMENT") {
      parts.push(
        data.devConnected === "unknown"
          ? "dev CLI connection status could not be read"
          : data.devConnected
            ? "dev CLI connected"
            : "dev CLI not connected"
      );
      parts.push("branches: list_branches with environment dev");
    } else if (isBranchableEnvironment(environment)) {
      parts.push("branches: list_branches with environment preview");
      const days = environment.previewAutoArchiveAfterDays;
      const excluded = environment.previewAutoArchiveExcludedBranches ?? [];
      parts.push(
        !data.canReadBranches
          ? "branch auto-archive policy not shown: needs read:branches"
          : days === null
            ? "branch auto-archive off"
            : `branches auto-archived ${days} day${days === 1 ? "" : "s"} after their last deployment, ${
                excluded.length === 0
                  ? "none excluded"
                  : `excluded: ${namesList(excluded, "branch-name")}`
              }`
      );
    } else if (!readable.has(environment.id)) {
      parts.push("current deployment not shown: needs read:deployments");
    } else {
      const deployment = data.current.get(environment.id);
      parts.push(
        deployment
          ? `current deployment ${describeDeploymentForAgent({ ...deployment, git: null })}`
          : "no current deployment"
      );
    }
    lines.push(parts.join(" | "));
  }
  return lines.join("\n");
}

type BranchesResult = Awaited<ReturnType<BranchesPresenter["call"]>>;

function renderBranches(env: "preview" | "dev", result: BranchesResult, now = new Date()) {
  if (!result.branchableEnvironment) {
    return "This project has no branchable preview environment. Enable preview branches in the dashboard first.";
  }
  const lines = [
    `Page ${result.currentPage} of ${Math.max(result.totalPages, 1)}; ${
      result.limits.limit >= NO_BRANCH_LIMIT
        ? `${result.limits.used} ${env} ${result.limits.used === 1 ? "branch" : "branches"}, no limit.`
        : `${result.limits.used} of ${result.limits.limit} ${env} branches used.`
    }`,
    "",
  ];
  if (result.branches.length === 0) lines.push("No branches found.");
  for (const branch of result.branches) {
    const parts = [`- ${agentFence(branch.branchName, "branch-name")}`];
    parts.push(branch.archivedAt ? `archived ${isoDate(branch.archivedAt)}` : "active");
    parts.push(`created ${isoDate(branch.createdAt)}`);
    if (branch.lastDeploymentAt) parts.push(`last deployment ${isoDate(branch.lastDeploymentAt)}`);
    if (branch.autoArchive && !branch.archivedAt) {
      parts.push(
        branch.autoArchive.status === "protected"
          ? "excluded from auto-archive"
          : branch.autoArchive.status === "inProgress"
            ? "deployment in progress, not auto-archived yet"
            : branch.autoArchive.archiveAt <= now
              ? `auto-archive overdue since ${isoDate(branch.autoArchive.archiveAt)}, archived at the next cleanup check`
              : `auto-archive due ${isoDate(branch.autoArchive.archiveAt)}`
      );
    }
    if (branch.type === "DEVELOPMENT") {
      parts.push(
        branch.isConnected === undefined
          ? "dev CLI not seen in the last 3 days"
          : branch.isConnected
            ? "dev CLI connected"
            : "dev CLI not connected"
      );
    }
    if (branch.git?.pullRequestNumber) parts.push(`pull request #${branch.git.pullRequestNumber}`);
    if (branch.git?.commitMessage) {
      parts.push(`last commit ${agentFence(branch.git.commitMessage, "git-commit-message")}`);
    }
    lines.push(parts.join(" | "));
  }
  if (result.currentPage < result.totalPages) {
    lines.push("", `More branches: call again with page ${result.currentPage + 1}.`);
  }
  return lines.join("\n");
}

function renderRegions(regions: Region[], projectHasDefault: boolean) {
  if (regions.length === 0) return "No regions are available to this project.";
  const lines = [`Found ${regions.length} region${regions.length === 1 ? "" : "s"}`, ""];
  for (const region of regions) {
    const parts = [`- ${plain(region.name, REGION_NAME, "region-name")}`];
    if (region.isDefault) {
      parts.push(
        projectHasDefault ? "project default" : "platform default (the project has none set)"
      );
    }
    if (region.cloudProvider) parts.push(agentFence(region.cloudProvider, "region-provider"));
    if (region.location) parts.push(agentFence(region.location, "region-location"));
    if (region.description) parts.push(agentFence(region.description, "region-description"));
    if (region.staticIPs) parts.push(`static IPs ${agentFence(region.staticIPs, "region-ips")}`);
    lines.push(parts.join(" | "));
  }
  return lines.join("\n");
}

export function createEnvironmentsTools(
  deps: EnvironmentsReadDeps = defaultDeps
): McpToolDefinition[] {
  return [
    defineReadTool({
      name: "list_environments",
      title: "List Environments",
      description:
        "List a project's environments (prod, staging, preview and your dev environment) with whether each is paused, its current deployment, the preview branch auto-archive policy and whether your dev CLI is connected. Branches are listed by list_branches.",
      shape: ListEnvironmentsInput.shape,
      auth: { action: "read", subject: "environments" },
      run: async (_input, ctx) => {
        if (!ctx.subject?.projectId) return plainError(PROJECT_NOT_FOUND);
        const read = await readEnvironments(
          ctx,
          deps,
          startReadBudget(deps.readBudgetMs, ctx.signal)
        );
        return read.ok ? textResult(renderEnvironments(read.value)) : stoppedResult(read);
      },
    }),
    defineReadTool({
      name: "list_branches",
      title: "List Branches",
      description:
        "List preview branches, or your own development branches, like the Branches pages in the dashboard: archived state, last deployment, when automatic archiving is due and whether the dev CLI is connected. 25 per page.",
      shape: ListBranchesInput.shape,
      auth: { action: "read", subject: "branches", resolveSubject: branchesSubject },
      run: async (input, ctx) => {
        const budget = startReadBudget(deps.readBudgetMs, ctx.signal);
        const project = await budget.read(() => findProject(ctx));
        if (!project.ok) return stoppedResult(project);
        if (!project.value) return plainError(PROJECT_NOT_FOUND);
        const result = await budget.read(() =>
          new BranchesPresenter().call({
            userId: ctx.identity.userId,
            projectSlug: project.value!.slug,
            env: input.environment === "dev" ? "development" : "preview",
            search: input.search,
            showArchived: input.showArchived,
            page: input.page,
          })
        );
        return result.ok
          ? textResult(renderBranches(input.environment, result.value))
          : stoppedResult(result);
      },
    }),
    defineReadTool({
      name: "list_regions",
      title: "List Regions",
      description:
        "List the regions this project's runs can execute in, like the Regions page, and which one is the project's default. Change the default with set_default_region.",
      shape: ListRegionsInput.shape,
      auth: { action: "read", subject: "projects" },
      run: async (_input, ctx) => {
        const budget = startReadBudget(deps.readBudgetMs, ctx.signal);
        const project = await budget.read(() => findProject(ctx));
        if (!project.ok) return stoppedResult(project);
        if (!project.value) return plainError(PROJECT_NOT_FOUND);
        const read = await budget.read(() =>
          new RegionsPresenter()
            .call({ userId: ctx.identity.userId, projectSlug: project.value!.slug })
            .then(
              (result) => ({ regions: result.regions }),
              (error: unknown) => ({ error })
            )
        );
        if (!read.ok) return stoppedResult(read);
        const result = read.value;
        if ("regions" in result) {
          return textResult(renderRegions(result.regions, !!project.value!.defaultWorkerGroupId));
        }
        const message = result.error instanceof Error ? result.error.message : "";
        if (message === "Default worker instance group not found") {
          return plainError(REGIONS_NOT_AVAILABLE);
        }
        logger.error("mcp.tool failed", {
          tool: "list_regions",
          error: `list_regions: ${message}`,
        });
        return plainError(READ_FAILED);
      },
    }),
  ];
}

export const environmentsTools = createEnvironmentsTools();
