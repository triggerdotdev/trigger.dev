import { createHash, createHmac } from "node:crypto";
import { isValidGitBranchName, sanitizeBranchName } from "@trigger.dev/core/v3/utils/gitBranch";
import { boundedIn } from "@trigger.dev/database";
import type { RbacAbility } from "@trigger.dev/rbac";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import {
  branchKey,
  branchSlugFor,
  checkBranchLimit,
  UpsertBranchService,
} from "~/services/upsertBranch.server";
import { isBranchableEnvironment } from "~/utils/branchableEnvironment";
import { PreviewAutoArchivePolicy } from "~/utils/previewAutoArchive";

type AutoArchivePolicy = { days: number | null; excludedBranches: string[] };
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { ServiceValidationError } from "~/v3/services/common.server";
import { defaultFingerprintKey } from "../confirm/confirmation.server";
import { branchLookupNames, firstBranchMatch } from "../gate/resolveSubject.server";
import type { McpSubject } from "../gate/types";
import type { McpToolDefinition } from "../registry.server";
import { fenceUntrusted } from "../gate/fence.server";
import { textResult } from "./define.server";
import { defineWriteTool, staleAnswer, staleApproval } from "./defineWrite.server";
import { branchesSubject, REGIONS_NOT_AVAILABLE } from "./environments.server";
import { agentFence, previewQuote } from "./format/environments";
import { plainError } from "./format/insights";
import { quoteForPreview } from "./format/webhooks";
import {
  ArchiveBranchInput,
  CreateBranchInput,
  SetAutoArchiveInput,
  SetDefaultRegionInput,
} from "./schemas/environments";

const REGION_NAME = /^[a-z0-9-]{1,64}$/;

const branchNotFound = (name: string) =>
  `Branch ${agentFence(name, "branch-name")} was not found in this environment. Use list_branches to see the branches in this environment.`;
const PROJECT_NOT_FOUND = "Project not found. Use list_projects to see your projects.";
const NOT_BRANCHABLE =
  "This environment has no branches. Use preview (with preview branches enabled in the dashboard) or dev; nothing changed.";
const NO_PREVIEW_ENVIRONMENT =
  "This project has no preview environment, so it has no preview branches; nothing changed.";
const NO_PREVIEW_BRANCHES =
  "This project has no branchable preview environment. Enable preview branches in the dashboard first; nothing changed.";
const COUNT_FAILED = "Unable to count the affected branches right now. Try again; nothing changed.";

const branchesAuth = { action: "write", subject: "branches" } as const;
const branchAuth = { ...branchesAuth, resolveSubject: branchesSubject };

type Kind = "preview" | "dev";
const kindLabel = (kind: Kind) => (kind === "preview" ? "preview" : "development");

const rootSelect = {
  id: true,
  slug: true,
  orgMemberId: true,
  type: true,
  parentEnvironmentId: true,
  isBranchableEnvironment: true,
  orgMember: { select: { userId: true } },
  previewAutoArchiveAfterDays: true,
  previewAutoArchiveExcludedBranches: true,
} as const;

async function branchableRoot(subject: McpSubject | null) {
  if (!subject?.environmentId || !subject.projectId) return null;
  const root = await prisma.runtimeEnvironment.findFirst({
    where: { id: subject.environmentId, projectId: subject.projectId, archivedAt: null },
    select: rootSelect,
  });
  return root && isBranchableEnvironment(root) ? root : null;
}

function parseBranchName(raw: string): string | Refusal {
  const name = sanitizeBranchName(raw);
  if (!name) return { refuse: "Branch name has an invalid format; nothing changed." };
  if (!isValidGitBranchName(name)) {
    return {
      refuse: "Invalid branch name, contains disallowed character sequences; nothing changed.",
    };
  }
  return name;
}

type BranchArgs = { environment: Kind; branchName: string };

type Refusal = { refuse: string };

const limitRefusal = (kind: Kind, limits: { used: number; limit: number }) =>
  `You've used all ${limits.used} of ${limits.limit} ${kindLabel(kind)} branches for your plan. Archive branches you no longer need with archive_branch${kind === "preview" ? ", or upgrade" : ""}; nothing changed.`;

async function planCreate(
  args: BranchArgs,
  subject: McpSubject | null
): Promise<Refusal | { name: string; preview: string }> {
  const name = parseBranchName(args.branchName);
  if (typeof name !== "string") return name;
  if (args.environment === "preview" && !subject?.environmentId) {
    return { refuse: NO_PREVIEW_ENVIRONMENT };
  }
  const root = await branchableRoot(subject);
  if (!root || !subject?.projectId) return { refuse: NOT_BRANCHABLE };

  const existing = await prisma.runtimeEnvironment.findFirst({
    where: { parentEnvironmentId: root.id, branchName: name, archivedAt: null },
    select: { id: true },
  });
  if (existing) {
    return {
      refuse: `Branch ${agentFence(name, "branch-name")} already exists. Archive it with archive_branch to create a new one with the same name; nothing changed.`,
    };
  }
  const branchSlug = branchSlugFor(root.slug, name);
  const taken = await prisma.runtimeEnvironment.findFirst({
    where: branchKey(root, subject.projectId, branchSlug),
    select: { archivedAt: true },
  });
  if (taken) {
    return {
      refuse: `Branch ${agentFence(name, "branch-name")} cannot be created: its environment slug ${agentFence(branchSlug, "environment-slug")} is already used by ${taken.archivedAt ? "an archived branch" : "another branch"}. Choose another name; nothing changed.`,
    };
  }

  const limits = await checkBranchLimit({
    prisma,
    organizationId: subject.organizationId,
    projectId: subject.projectId,
    userId: root.orgMember?.userId,
    type: root.type === "DEVELOPMENT" ? "DEVELOPMENT" : "PREVIEW",
    newBranchName: name,
  });
  if (limits.isAtLimit) return { refuse: limitRefusal(args.environment, limits) };

  const preview = [
    `Create ${kindLabel(args.environment)} branch ${quoteForPreview(name)}.`,
    "It is a new environment with its own API keys (not shown), its own runs and no deployments yet.",
    args.environment === "preview"
      ? "Tasks run in it once a deployment is made to the branch."
      : "Tasks run in it when you run the dev CLI on this branch.",
    "It starts paused if the organization is over its billing limit.",
  ].join(" ");
  return { name, preview };
}

async function planArchive(
  args: BranchArgs,
  subject: McpSubject | null
): Promise<Refusal | { branchId: string; preview: string }> {
  if (args.environment === "preview" && !subject?.environmentId) {
    return { refuse: NO_PREVIEW_ENVIRONMENT };
  }
  const root = await branchableRoot(subject);
  if (!root) return { refuse: NOT_BRANCHABLE };
  const names = branchLookupNames(args.branchName);
  const branch = await firstBranchMatch(names, (branchName) =>
    prisma.runtimeEnvironment.findFirst({
      where: { parentEnvironmentId: root.id, branchName },
      orderBy: { archivedAt: { sort: "desc", nulls: "first" } },
      select: { id: true, branchName: true, archivedAt: true },
    })
  );
  if (!branch) return { refuse: branchNotFound(args.branchName) };
  if (branch.archivedAt) {
    return {
      refuse: `Branch ${agentFence(branch.branchName ?? "", "branch-name")} is already archived; nothing changed.`,
    };
  }
  const name = branch.branchName ?? "";
  return {
    branchId: branch.id,
    preview: [
      `Archive ${kindLabel(args.environment)} branch ${quoteForPreview(name)}.`,
      "This permanently makes the branch read-only and cannot be undone (there is no unarchive).",
      "Runs can no longer be triggered or executed in it, its API keys stop working, and its schedules stop triggering runs.",
      "The branch and its past runs stay visible.",
      "A new branch with the same name can be created afterwards.",
      `Branch id ${branch.id}: if this branch is archived or replaced before this runs, it is refused.`,
    ].join(" "),
  };
}

type AutoArchiveArgs = { days: number | null; excludedBranches?: string[] };

const describePolicy = (days: number | null) =>
  days === null ? "off" : `archive after ${days} day${days === 1 ? "" : "s"} without a deployment`;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const SHOWN_EXCLUSIONS = 20;
const SHOWN_OVERDUE = 10;

type Overdue = { names: string[]; partial: boolean; showNames: boolean; fingerprint: string };

/** A keyed fingerprint of a set of names: changes when any name does, and guessed names can't be checked against it. */
const namesFingerprint = (
  key: string,
  projectId: string,
  purpose: "excluded" | "overdue",
  names: string[]
) =>
  createHmac("sha256", key)
    .update(JSON.stringify([projectId, purpose, [...names].sort()]))
    .digest("hex")
    .slice(0, 12);

function overdueText(
  { names, partial, showNames, fingerprint }: Overdue,
  quote: (name: string) => string,
  forApproval: boolean
): string {
  const set = forApproval ? `set ${fingerprint}` : "";
  if (names.length === 0) {
    return partial
      ? "No preview branch among the first ones checked is past that age yet."
      : "No preview branch is past that age yet.";
  }
  const more =
    names.length > SHOWN_OVERDUE
      ? ` (+${names.length - SHOWN_OVERDUE} more${set ? `, ${set}` : ""})`
      : "";
  const list = showNames
    ? `: ${names.slice(0, SHOWN_OVERDUE).map(quote).join(", ")}${more}`
    : ` (${set ? `${set}; ` : ""}names not shown: needs read:branches)`;
  return `${partial ? "At least " : ""}${names.length} preview ${plural(names.length, "branch is", "branches are")} already past that age and ${plural(names.length, "becomes", "become")} eligible for archiving at the next cleanup check, which may archive ${plural(names.length, "it", "them")} within minutes${list}.`;
}

function exclusionsForPreview(names: string[]): string {
  if (names.length === 0) return "no branch excluded";
  const sorted = [...names].sort();
  const shown = sorted.slice(0, SHOWN_EXCLUSIONS).map(quoteForPreview).join(", ");
  const rest = sorted.length - SHOWN_EXCLUSIONS;
  if (rest <= 0) return `excluded: ${shown}`;
  const digest = createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 12);
  return `excluded: ${shown} and ${rest} more (set ${digest})`;
}

async function planAutoArchive(
  args: AutoArchiveArgs,
  subject: McpSubject | null,
  ability: RbacAbility | undefined,
  fingerprintKey: string
): Promise<
  | Refusal
  | {
      parentId: string;
      policy: AutoArchivePolicy;
      previous: AutoArchivePolicy;
      overdue: Overdue | null;
      preview: string;
    }
> {
  if (!subject?.projectId) return { refuse: NO_PREVIEW_BRANCHES };
  const showNames = !!ability?.can("read", { type: "branches", envType: "PREVIEW" });
  const parent = await prisma.runtimeEnvironment.findFirst({
    where: {
      projectId: subject.projectId,
      type: "PREVIEW",
      parentEnvironmentId: null,
      isBranchableEnvironment: true,
      archivedAt: null,
    },
    select: rootSelect,
  });
  if (!parent) return { refuse: NO_PREVIEW_BRANCHES };

  const policy = PreviewAutoArchivePolicy.safeParse({
    days: args.days,
    excludedBranches: args.excludedBranches ?? parent.previewAutoArchiveExcludedBranches,
  });
  if (!policy.success) {
    return { refuse: "Enter 1–365 days and up to 100 valid branch names; nothing changed." };
  }
  const { days, excludedBranches } = policy.data;
  const oldExcluded = parent.previewAutoArchiveExcludedBranches;
  const sameExclusions =
    oldExcluded.length === excludedBranches.length &&
    excludedBranches.every((name) => oldExcluded.includes(name));
  const unchangedExclusions = args.excludedBranches === undefined || (showNames && sameExclusions);
  if (days === parent.previewAutoArchiveAfterDays && unchangedExclusions) {
    return {
      refuse: `Automatic archiving of preview branches is already ${describePolicy(days)} with these exclusions; nothing changed.`,
    };
  }

  const lines = [
    `Change automatic archiving of preview branches from ${describePolicy(parent.previewAutoArchiveAfterDays)} (${showNames ? exclusionsForPreview(oldExcluded) : `${oldExcluded.length} excluded, set ${namesFingerprint(fingerprintKey, subject.projectId, "excluded", oldExcluded)}; names not shown: needs read:branches`}) to ${describePolicy(days)}.`,
    args.excludedBranches === undefined
      ? `The current ${oldExcluded.length} excluded ${plural(oldExcluded.length, "branch is", "branches are")} kept.`
      : excludedBranches.length === 0
        ? "No branch is excluded."
        : `Only these branches are excluded: ${excludedBranches.map(quoteForPreview).join(", ")}.`,
  ];

  const base = {
    parentId: parent.id,
    policy: policy.data,
    previous: { days: parent.previewAutoArchiveAfterDays, excludedBranches: oldExcluded },
  };
  if (days === null) {
    lines.push(
      "No branch is archived automatically after this. Branches already archived stay archived."
    );
    return { ...base, overdue: null, preview: lines.join(" ") };
  }
  const { previewAutoArchiveCount } = await import("~/services/previewAutoArchive.server");
  const counted = await previewAutoArchiveCount(prisma, parent.id, days, excludedBranches).catch(
    (error: unknown) => {
      logger.error("mcp.tool failed", {
        tool: "set_preview_auto_archive",
        error: `set_preview_auto_archive: ${error instanceof Error ? error.message : String(error)}`,
      });
      return null;
    }
  );
  if (!counted) return { refuse: COUNT_FAILED };
  const covered = counted.count + counted.scheduled + counted.inProgress;
  const overdue = {
    names: counted.ready,
    partial: counted.partial,
    showNames,
    fingerprint: namesFingerprint(fingerprintKey, subject.projectId, "overdue", counted.ready),
  };
  const afterLast = `${days} ${plural(days, "day", "days")} after its last deployment (or its creation if it has none) unless deployed to again`;
  const excludedCount = counted.protectedBranches.length;
  lines.push(
    overdueText(overdue, quoteForPreview, true),
    covered === 0 && !counted.partial
      ? `It covers no preview branch right now; a branch created later, unless its name is on the exclusion list, is archived ${afterLast}.`
      : `It covers ${counted.partial ? "at least " : ""}${covered} preview ${plural(covered, "branch", "branches")}: each is archived ${afterLast}.`,
    `${
      counted.inProgress === 0 && !counted.partial
        ? ""
        : `${counted.partial ? "At least " : ""}${counted.inProgress} with a deployment in progress ${plural(counted.inProgress, "waits", "wait")} until it finishes, and `
    }${counted.partial ? "at least " : ""}${excludedCount} excluded ${plural(excludedCount, "branch is", "branches are")} never archived automatically.`,
    "Archiving makes a branch permanently read-only: runs can no longer be triggered or executed in it, its schedules stop, and it cannot be undone."
  );
  return { ...base, overdue, preview: lines.join(" ") };
}

async function planRegion(
  args: { region: string },
  subject: McpSubject | null
): Promise<Refusal | { regionId: string; currentDefaultId: string | null; preview: string }> {
  if (!subject?.projectId) return { refuse: PROJECT_NOT_FOUND };
  const project = await prisma.project.findFirst({
    where: { id: subject.projectId, deletedAt: null },
    select: {
      defaultWorkerGroupId: true,
      allowedWorkerQueues: true,
      organization: { select: { featureFlags: true } },
    },
  });
  if (!project) return { refuse: PROJECT_NOT_FOUND };

  const { makeFlag } = await import("~/v3/featureFlags.server");
  const { defaultVisibilityFilter, resolveComputeAccess } =
    await import("~/v3/regionAccess.server");
  const globalDefault = await makeFlag(prisma)({ key: FEATURE_FLAG.defaultWorkerInstanceGroupId });
  if (!globalDefault) return { refuse: REGIONS_NOT_AVAILABLE };

  const hasComputeAccess = await resolveComputeAccess(prisma, project.organization.featureFlags);
  const matches = await prisma.workerInstanceGroup.findMany({
    where: {
      name: args.region,
      ...(project.allowedWorkerQueues.length > 0
        ? { masterQueue: { in: boundedIn(project.allowedWorkerQueues) } }
        : defaultVisibilityFilter(hasComputeAccess)),
    },
    select: { id: true, name: true },
    take: 2,
  });
  if (matches.length > 1) {
    return {
      refuse: `Region ${agentFence(args.region, "region-name")} is ambiguous: more than one region has that name, so it cannot be chosen by name. Set the default on the Regions page; nothing changed.`,
    };
  }
  const region = matches[0];
  if (!region) {
    return {
      refuse: `Region ${agentFence(args.region, "region-name")} is not available to this project. list_regions lists the regions you can use; nothing changed.`,
    };
  }

  const inherited = !project.defaultWorkerGroupId;
  const currentId = project.defaultWorkerGroupId ?? globalDefault;
  if (currentId === region.id) {
    return {
      refuse: `Region ${agentFence(region.name, "region-name")} is already ${inherited ? "the default: it is the platform default and the project has none set" : "the project's default region"}; nothing changed.`,
    };
  }
  const current = await prisma.workerInstanceGroup.findFirst({
    where: { id: currentId },
    select: { name: true },
  });
  const label = (name: string) => (REGION_NAME.test(name) ? name : previewQuote(name));
  const from = current
    ? inherited
      ? `the platform default ${label(current.name)} (none set on the project)`
      : label(current.name)
    : "none";
  return {
    regionId: region.id,
    currentDefaultId: project.defaultWorkerGroupId,
    preview: [
      `Change the project's default region from ${from} to ${label(region.name)}.`,
      "Runs triggered from now on in deployed environments without their own region run there; runs already triggered keep their region.",
      "The dev environment is not affected. It can be changed back at any time.",
    ].join(" "),
  };
}

const canReadBranches = (ability: RbacAbility | undefined) =>
  !!ability?.can("read", { type: "branches", envType: "PREVIEW" });

const canWritePreviewBranches = (ability: RbacAbility | undefined) =>
  !!ability?.can("write", { type: "branches", envType: "PREVIEW" });

export function createEnvironmentsWriteTools(
  fingerprintKey: () => Promise<string> = defaultFingerprintKey
): McpToolDefinition[] {
  return [
    defineWriteTool({
      name: "create_branch",
      title: "Create Branch",
      description:
        "Create a preview branch, or a branch of your own dev environment, like New branch on the Branches pages. Each branch is its own environment with its own runs.",
      shape: CreateBranchInput.shape,
      approval: "configurable",
      auth: branchAuth,
      confirm: {
        preview: async (args, subject) => {
          const plan = await planCreate(args, subject);
          return "refuse" in plan ? plan : plan.preview;
        },
      },
      run: async (input, ctx) => {
        const plan = await planCreate(input, ctx.subject);
        if ("refuse" in plan) return plainError(plan.refuse);
        const stale = staleApproval(ctx, plan.preview, plainError);
        if (stale) return stale;

        const result = await new UpsertBranchService(prisma).call(
          { type: "userMembership", userId: ctx.identity.userId },
          {
            projectId: ctx.subject!.projectId!,
            env: input.environment === "preview" ? "preview" : "development",
            branchName: input.branchName,
          },
          { archiveToMakeRoom: false }
        );
        if (!result.success) {
          return plainError(
            result.limits
              ? limitRefusal(input.environment, result.limits)
              : `${agentFence(result.error, "branch-error")} Nothing changed.`
          );
        }
        const name = agentFence(plan.name, "branch-name");
        if (result.alreadyExisted) {
          return plainError(`Branch ${name} already exists. Nothing changed.`);
        }
        return textResult(`Created ${kindLabel(input.environment)} branch ${name}.`);
      },
    }),
    defineWriteTool({
      name: "archive_branch",
      title: "Archive Branch",
      description:
        "Archive a preview branch, or a branch of your own dev environment, like Archive branch on the Branches pages. It becomes permanently read-only: no runs can be triggered or executed in it. This cannot be undone.",
      shape: ArchiveBranchInput.shape,
      approval: "required",
      auth: branchAuth,
      confirm: {
        preview: async (args, subject) => {
          const plan = await planArchive(args, subject);
          return "refuse" in plan ? plan : plan.preview;
        },
      },
      run: async (input, ctx) => {
        const plan = await planArchive(input, ctx.subject);
        if ("refuse" in plan) return plainError(plan.refuse);
        const stale = staleApproval(ctx, plan.preview, plainError);
        if (stale) return stale;

        const { ArchiveBranchService } = await import("~/services/archiveBranch.server");
        const result = await new ArchiveBranchService(prisma).call(
          { type: "userMembership", userId: ctx.identity.userId },
          { environmentId: plan.branchId }
        );
        if (!result.success) return plainError(fenceUntrusted(result.error, "branch-error"));
        return textResult(
          `Archived ${kindLabel(input.environment)} branch ${agentFence(result.branch.branchName ?? "", "branch-name")}.`
        );
      },
    }),
    defineWriteTool({
      name: "set_preview_auto_archive",
      title: "Set Preview Branch Auto-Archive",
      description:
        "Set or turn off automatic archiving of preview branches, like the auto-archive settings on the Preview branches page: branches are archived a number of days after their last deployment (or creation), except excluded branch names. Pass days null to turn it off.",
      shape: SetAutoArchiveInput.shape,
      approval: "required",
      auth: branchesAuth,
      confirm: {
        precheck: (_args, ability) =>
          canWritePreviewBranches(ability) ? undefined : { action: "write", subject: "branches" },
        preview: async (args, subject, ability) => {
          const plan = await planAutoArchive(args, subject, ability, await fingerprintKey());
          return "refuse" in plan ? plan : plan.preview;
        },
      },
      run: async (input, ctx) => {
        if (!canWritePreviewBranches(ctx.ability)) {
          return plainError(
            "Not authorized: your role in this organization does not allow write on branches"
          );
        }
        const plan = await planAutoArchive(input, ctx.subject, ctx.ability, await fingerprintKey());
        if ("refuse" in plan) return plainError(plan.refuse);
        const stale = staleApproval(ctx, plan.preview, plainError);
        if (stale) return stale;

        const { savePreviewAutoArchivePolicy } =
          await import("~/services/previewAutoArchive.server");
        const saved = await savePreviewAutoArchivePolicy(
          prisma,
          plan.parentId,
          plan.policy,
          undefined,
          plan.previous
        );
        if (saved?.stale) return staleAnswer(plainError);
        const excluded = plan.policy.excludedBranches.length;
        return textResult(
          plan.policy.days === null
            ? `Automatic archiving of preview branches is now off. The exclusion list (${excluded} ${plural(excluded, "branch", "branches")}) is ${input.excludedBranches === undefined ? "kept" : !canReadBranches(ctx.ability) ? "saved as given" : JSON.stringify([...new Set(plan.policy.excludedBranches)].sort()) === JSON.stringify([...new Set(plan.previous.excludedBranches)].sort()) ? "kept" : "replaced"} for when it is turned on again.`
            : `Preview branches are now archived ${plan.policy.days} ${plural(plan.policy.days, "day", "days")} after their last deployment, with ${excluded} excluded ${plural(excluded, "branch", "branches")}.${plan.overdue ? ` ${overdueText(plan.overdue, (name) => agentFence(name, "branch-name"), false)}` : ""}`
        );
      },
    }),
    defineWriteTool({
      name: "set_default_region",
      title: "Set Default Region",
      description:
        "Set the project's default region, like Set as default on the Regions page. Runs triggered afterwards in deployed environments without their own region run there. list_regions lists the regions.",
      shape: SetDefaultRegionInput.shape,
      approval: "configurable",
      auth: { action: "manage", subject: "project" },
      confirm: {
        preview: async (args, subject) => {
          const plan = await planRegion(args, subject);
          return "refuse" in plan ? plan : plan.preview;
        },
      },
      run: async (input, ctx) => {
        const plan = await planRegion(input, ctx.subject);
        if ("refuse" in plan) return plainError(plan.refuse);
        const stale = staleApproval(ctx, plan.preview, plainError);
        if (stale) return stale;

        const { DEFAULT_REGION_CHANGED, SetDefaultRegionService } =
          await import("~/v3/services/setDefaultRegion.server");
        try {
          const region = await new SetDefaultRegionService().call({
            projectId: ctx.subject!.projectId!,
            regionId: plan.regionId,
            expectedDefaultRegionId: plan.currentDefaultId,
          });
          return textResult(
            `The project's default region is now ${agentFence(region.name, "region-name")}.`
          );
        } catch (error) {
          if (error instanceof ServiceValidationError) {
            if (error.message === DEFAULT_REGION_CHANGED) return staleAnswer(plainError);
            return plainError(fenceUntrusted(error.message, "region-error"));
          }
          throw error;
        }
      },
    }),
  ];
}

export const environmentsWriteTools = createEnvironmentsWriteTools();
