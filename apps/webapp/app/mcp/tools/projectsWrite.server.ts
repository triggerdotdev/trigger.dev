import { CURRENT_DEPLOYMENT_LABEL } from "@trigger.dev/core/v3/isomorphic";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import type { RbacAbility } from "@trigger.dev/rbac";
import { prisma } from "~/db.server";
import { DeleteProjectService } from "~/services/deleteProject.server";
import { logger } from "~/services/logger.server";
import { engine } from "~/v3/runEngine.server";
import type { McpPreviewRefusal, McpSubject } from "../gate/types";
import type { McpToolDefinition } from "../registry.server";
import { textResult } from "./define.server";
import { defineWriteTool, staleAnswer, staleApproval } from "./defineWrite.server";
import { agentFence, describeDeploymentForPreview, previewQuote } from "./format/environments";
import { plainError } from "./format/insights";
import { startReadBudget } from "./readBudget.server";
import { DeleteProjectInput, RenameProjectInput } from "./schemas/projects";

const SLUG = /^[a-z0-9-]{1,64}$/;
const REF = /^proj_[a-z0-9]{1,64}$/;
const ENVIRONMENT_LIMIT = 1000;
const READ_BUDGET_MS = 10_000;
const COUNT_BATCH = 20;
const RUNS = "Runs: ";
const PICKED_UP =
  "Queued runs are cancelled when picked up, but one picked up by a process that still holds cached project state may start.";

const auth = { action: "manage", subject: "project" } as const;

const projectNotFound = (ref: string) =>
  `Project ${agentFence(ref, "project-ref")} was not found or is already deleted. Use list_projects to see your projects; nothing changed.`;

const plainOr = (value: string, pattern: RegExp) =>
  pattern.test(value) ? value : previewQuote(value);

const revisionLine = (updatedAt: Date) =>
  `Project revision ${updatedAt.toISOString()}: if the project changes before this runs, it is refused.`;

const refForAgent = (ref: string) => (REF.test(ref) ? ref : agentFence(ref, "project-ref"));

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function findProject(subject: McpSubject | null) {
  if (!subject?.projectId) return null;
  return prisma.project.findFirst({
    where: { id: subject.projectId, organizationId: subject.organizationId, deletedAt: null },
    select: {
      id: true,
      name: true,
      slug: true,
      externalRef: true,
      updatedAt: true,
      organization: { select: { id: true, title: true } },
    },
  });
}

type Project = NonNullable<Awaited<ReturnType<typeof findProject>>>;

function parseProjectName(raw: string): string | McpPreviewRefusal {
  const name = raw.trim();
  if (name.length < 3 || name.length > 50) {
    return { refuse: "A project name must be 3 to 50 characters; nothing changed." };
  }
  return name;
}

async function planRename(
  args: { projectRef: string; name: string },
  subject: McpSubject | null
): Promise<McpPreviewRefusal | { project: Project; name: string; preview: string }> {
  const name = parseProjectName(args.name);
  if (typeof name !== "string") return name;
  const project = await findProject(subject);
  if (!project) return { refuse: projectNotFound(args.projectRef) };
  if (project.name === name) {
    return {
      refuse: `The project is already named ${agentFence(name, "project-name")}; nothing changed.`,
    };
  }
  return {
    project,
    name,
    preview: [
      `Rename project ${previewQuote(project.name)} to ${previewQuote(name)} in organization ${previewQuote(project.organization.title)}.`,
      `Its ref ${plainOr(project.externalRef, REF)} and slug ${plainOr(project.slug, SLUG)} do not change, so its dashboard URLs, API keys and trigger.config.ts keep working.`,
      revisionLine(project.updatedAt),
    ].join("\n"),
  };
}

type Environment = {
  id: string;
  type: RuntimeEnvironmentType;
  parentEnvironmentId: string | null;
  maximumConcurrencyLimit: number;
  concurrencyLimitBurstFactor: { toNumber(): number };
};

type LiveRunCounts = (
  environments: Environment[],
  project: { id: string; organizationId: string },
  live: () => boolean
) => Promise<{ queued: number; executing: number } | null>;

const engineRunCounts: LiveRunCounts = async (environments, project, live) => {
  const sum = { queued: 0, executing: 0 };
  for (let i = 0; i < environments.length; i += COUNT_BATCH) {
    if (!live()) return null;
    const counts = await Promise.all(
      environments.slice(i, i + COUNT_BATCH).map((environment) => {
        const env = {
          ...environment,
          project: { id: project.id },
          organization: { id: project.organizationId },
        };
        return Promise.all([engine.lengthOfEnvQueue(env), engine.concurrencyOfEnvQueue(env)]);
      })
    );
    for (const [queued, executing] of counts) {
      sum.queued += queued;
      sum.executing += executing;
    }
  }
  return sum;
};

/** An opaque digest of every active environment of the project, past the display cap too. */
async function environmentSet(projectId: string) {
  const [set] = await prisma.$queryRaw<[{ digest: string }]>`
    SELECT md5(coalesce(string_agg(id, ',' ORDER BY id), '')) AS digest
    FROM "RuntimeEnvironment" WHERE "projectId" = ${projectId} AND "archivedAt" IS NULL`;
  return set.digest.slice(0, 12);
}

/** The preview without its run counts, which change constantly and are not checked again. */
const boundFacts = (preview: string) =>
  preview
    .split("\n")
    .filter((line) => !line.startsWith(RUNS))
    .join("\n");

function canReadIn(
  ability: RbacAbility | undefined,
  type: string,
  envTypes: RuntimeEnvironmentType[]
) {
  if (!ability) return false;
  return envTypes.length === 0
    ? ability.can("read", { type })
    : envTypes.every((envType) => ability.can("read", { type, envType }));
}

async function planDelete(
  args: { projectRef: string },
  subject: McpSubject | null,
  ability: RbacAbility | undefined,
  liveRunCounts: LiveRunCounts | null,
  signal: AbortSignal
): Promise<McpPreviewRefusal | { project: Project; preview: string }> {
  const project = await findProject(subject);
  if (!project) return { refuse: projectNotFound(args.projectRef) };

  const found = await prisma.runtimeEnvironment.findMany({
    where: { projectId: project.id, archivedAt: null },
    select: {
      id: true,
      type: true,
      parentEnvironmentId: true,
      maximumConcurrencyLimit: true,
      concurrencyLimitBurstFactor: true,
    },
    orderBy: { createdAt: "asc" },
    take: ENVIRONMENT_LIMIT + 1,
  });
  const partial = found.length > ENVIRONMENT_LIMIT;
  const environments = found.slice(0, ENVIRONMENT_LIMIT);
  const atLeast = partial ? "at least " : "";
  const envTypes = [...new Set(environments.map(({ type }) => type))];
  const can = (type: string) => canReadIn(ability, type, envTypes);

  const lines = [
    `Delete project ${previewQuote(project.name)} (slug ${plainOr(project.slug, SLUG)}, ref ${plainOr(project.externalRef, REF)}) in organization ${previewQuote(project.organization.title)}.`,
    "This cannot be undone: the project is marked deleted and nothing in the dashboard, the API or this server restores it.",
  ];

  if (!can("environments")) {
    lines.push("Environments: not shown, needs read:environments.");
  } else {
    const branches = (type: RuntimeEnvironmentType) =>
      environments.filter((e) => e.type === type && e.parentEnvironmentId).length;
    lines.push(
      `Environments: ${atLeast}${environments.length} (including ${plural(branches("PREVIEW"), "preview branch", "preview branches")} and ${plural(branches("DEVELOPMENT"), "dev branch", "dev branches")}).`
    );
  }

  const production = environments.find((e) => e.type === "PRODUCTION" && !e.parentEnvironmentId);
  if (!can("environments")) {
    lines.push("Production: not shown, needs read:environments.");
  } else if (!production) {
    lines.push("Production: no production environment.");
  } else if (!ability?.can("read", { type: "deployments", envType: "PRODUCTION" })) {
    lines.push("Production: current deployment not shown, needs read:deployments.");
  } else {
    const current = await prisma.workerDeploymentPromotion.findFirst({
      where: { environmentId: production.id, label: CURRENT_DEPLOYMENT_LABEL },
      select: { deployment: { select: { version: true, shortCode: true, git: true } } },
    });
    lines.push(
      current
        ? `Production: current deployment ${describeDeploymentForPreview(current.deployment)}.`
        : "Production: no current deployment."
    );
  }

  if (!can("tasks")) {
    lines.push("Schedules: not shown, needs read:tasks.");
  } else {
    const schedules = await prisma.taskSchedule.count({
      where: {
        projectId: project.id,
        active: true,
        instances: { some: { active: true, environment: { archivedAt: null } } },
      },
    });
    lines.push(
      `Schedules: ${plural(schedules, "active schedule", "active schedules")}; schedules stop triggering runs.`
    );
  }

  if (!liveRunCounts) {
    lines.push(`${RUNS}not counted again.`);
  } else if (!can("runs")) {
    lines.push(`${RUNS}queued and executing runs not shown, needs read:runs.`);
  } else {
    const budget = startReadBudget(READ_BUDGET_MS, signal);
    const counted = await budget.read(() =>
      liveRunCounts(
        environments,
        { id: project.id, organizationId: project.organization.id },
        () => budget.remainingMs() > 0 && !signal.aborted
      ).catch((error: unknown) => {
        logger.error("mcp.tool failed", {
          tool: "delete_project",
          error: `delete_project: ${error instanceof Error ? error.message : String(error)}`,
        });
        return null;
      })
    );
    lines.push(
      counted.ok && counted.value
        ? `${RUNS}about ${atLeast}${counted.value.queued} queued and ${atLeast}${counted.value.executing} executing when this preview was made; these counts are not checked again.`
        : `${RUNS}queued and executing runs could not be counted right now.`
    );
  }

  lines.push(
    `Its queues are removed from scheduling. ${PICKED_UP} Runs already executing are not cancelled.`,
    "Its API keys stop working. Its runs, deployments and other data are kept but can no longer be opened.",
    `Checked again right before the delete starts: project revision ${project.updatedAt.toISOString()}, environment set ${await environmentSet(project.id)} and the facts above except the run counts. If any differ, nothing is deleted.`
  );
  return { project, preview: lines.join("\n") };
}

const NO_SIGNAL = new AbortController().signal;

export const projectsWriteTools: McpToolDefinition[] = [
  defineWriteTool({
    name: "rename_project",
    title: "Rename Project",
    description:
      "Rename a project, like Rename on the project's General settings page. The name is trimmed and must then be 3 to 50 characters. Its ref and slug do not change.",
    shape: RenameProjectInput.shape,
    approval: "required",
    auth,
    confirm: {
      preview: async (args, subject) => {
        const plan = await planRename(args, subject);
        return "refuse" in plan ? plan : plan.preview;
      },
    },
    run: async (input, ctx) => {
      const plan = await planRename(input, ctx.subject);
      if ("refuse" in plan) return plainError(plan.refuse);
      const stale = staleApproval(ctx, plan.preview, plainError);
      if (stale) return stale;

      const { count } = await prisma.project.updateMany({
        where: { id: plan.project.id, updatedAt: plan.project.updatedAt, deletedAt: null },
        data: { name: plan.name },
      });
      if (count === 0) return staleAnswer(plainError);
      return textResult(
        `Renamed project ${agentFence(plan.project.name, "project-name")} to ${agentFence(plan.name, "project-name")}. Its ref ${refForAgent(plan.project.externalRef)} and slug ${agentFence(plan.project.slug, "project-slug")} are unchanged.`
      );
    },
  }),
  defineWriteTool({
    name: "delete_project",
    title: "Delete Project",
    description:
      "Delete a project, like Delete project on the project's General settings page. Its schedules stop and its API keys stop working. Queued runs are cancelled when picked up, but one picked up by a process that still holds cached project state may start. This cannot be undone.",
    shape: DeleteProjectInput.shape,
    approval: "required",
    auth,
    confirm: {
      preview: async (args, subject, ability) => {
        const plan = await planDelete(args, subject, ability, engineRunCounts, NO_SIGNAL);
        return "refuse" in plan ? plan : plan.preview;
      },
    },
    run: async (input, ctx) => {
      const plan = await planDelete(input, ctx.subject, ctx.ability, null, ctx.signal);
      if ("refuse" in plan) return plainError(plan.refuse);
      const stale = staleApproval(
        ctx.confirmation
          ? {
              ...ctx,
              confirmation: { ...ctx.confirmation, preview: boundFacts(ctx.confirmation.preview) },
            }
          : ctx,
        boundFacts(plan.preview),
        plainError
      );
      if (stale) return stale;

      const name = agentFence(plan.project.name, "project-name");
      const ref = refForAgent(plan.project.externalRef);
      try {
        await new DeleteProjectService().call({
          projectId: plan.project.id,
          userId: ctx.identity.userId,
        });
      } catch (error) {
        logger.error("mcp.tool failed", {
          tool: "delete_project",
          error: `delete_project: ${error instanceof Error ? error.message : String(error)}`,
        });
        return plainError(
          `Deleting project ${name} (ref ${ref}) failed before it was marked deleted, so the project is not deleted. Some of its queues may already be removed from scheduling; call delete_project again to finish.`
        );
      }
      return textResult(
        `Deleted project ${name} (ref ${ref}). Its schedules no longer trigger runs and its queues were removed from scheduling. ${PICKED_UP}`
      );
    },
  }),
];
