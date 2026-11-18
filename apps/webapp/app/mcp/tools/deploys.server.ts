import parseDuration from "parse-duration";
import { parseDate } from "@trigger.dev/core/v3/isomorphic";
import { $replica } from "~/db.server";
import { fenceUntrusted } from "../gate/fence.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult, resolveToolEnvironment, textResult } from "./define.server";
import { ListDeploysInput, ListPreviewBranchesInput } from "./schemas/deploys";

function createdAtFilter(
  input: ListDeploysInput
): { filter: { createdAt?: { gte: Date; lte?: Date } } } | { error: string } {
  if (input.period) {
    const duration = parseDuration(input.period, "ms");
    if (!duration) return { error: `Invalid search query parameter: period=${input.period}` };
    return { filter: { createdAt: { gte: new Date(Date.now() - duration), lte: new Date() } } };
  }

  const from = input.from ? parseDate(input.from) : undefined;
  const to = input.from && input.to ? parseDate(input.to) : undefined;
  if (input.from && !from) return { error: `Invalid search query parameter: from=${input.from}` };
  if (input.from && input.to && !to) {
    return { error: `Invalid search query parameter: to=${input.to}` };
  }

  return { filter: from ? { createdAt: { gte: from, ...(to ? { lte: to } : {}) } } : {} };
}

const listDeploys = defineReadTool({
  name: "list_deploys",
  title: "List Deploys",
  description:
    "List all deploys for a project. Use this tool when you need to search for a deploy or list all deploys for a project.",
  shape: ListDeploysInput.shape,
  auth: { action: "read", subject: "deployments" },
  run: async (input, ctx) => {
    const environment = await resolveToolEnvironment(ctx);
    if (!environment) return errorResult("Environment not found");

    const created = createdAtFilter(input);
    if ("error" in created) return errorResult(created.error);

    const limit = Math.max(Math.min(input.limit ?? 20, 100), 5);

    const afterDeployment = input.cursor
      ? await $replica.workerDeployment.findFirst({
          where: { friendlyId: input.cursor, environmentId: environment.id },
        })
      : undefined;
    if (input.cursor && !afterDeployment) return errorResult("Invalid cursor");

    const deployments = await $replica.workerDeployment.findMany({
      where: {
        environmentId: environment.id,
        ...(afterDeployment ? { id: { lt: afterDeployment.id } } : {}),
        ...created.filter,
        ...(input.status ? { status: input.status } : {}),
      },
      orderBy: { id: "desc" },
      take: limit + 1,
    });

    const hasMore = deployments.length > limit;
    const deploys = hasMore ? deployments.slice(0, limit) : deployments;

    const lines: string[] = [];
    lines.push(`Found ${deploys.length} deployment${deploys.length === 1 ? "" : "s"}`);
    lines.push("");

    for (const deploy of deploys) {
      const deployedAt = deploy.deployedAt
        ? deploy.deployedAt
            .toISOString()
            .replace("T", " ")
            .replace(/\.\d+Z$/, " UTC")
        : "not deployed";
      const git =
        deploy.git && typeof deploy.git === "object" && "commitMessage" in deploy.git
          ? ` | ${fenceUntrusted(String(deploy.git.commitMessage), "deploy-commit-message")}`
          : "";
      lines.push(
        `- ${deploy.shortCode} | v${deploy.version} | ${deploy.status} | ${deployedAt}${git}`
      );
    }

    if (hasMore) {
      lines.push("");
      lines.push("Next page available →");
      lines.push(`Next cursor: ${deploys[deploys.length - 1]!.friendlyId}`);
    }

    return textResult(lines.join("\n"));
  },
});

const listPreviewBranches = defineReadTool({
  name: "list_preview_branches",
  title: "List Preview Branches",
  description:
    "List all preview branches for a project. Use this tool when you need to search for a preview branch or list all preview branches for a project.",
  shape: ListPreviewBranchesInput.shape,
  auth: { action: "read", subject: "branches" },
  run: async (_input, { subject }) => {
    if (!subject?.projectId) return errorResult("Project not found");

    const previewEnvironment = await $replica.runtimeEnvironment.findFirst({
      select: { id: true },
      where: { projectId: subject.projectId, slug: "preview" },
    });

    if (!previewEnvironment) {
      return errorResult(
        "You don't have preview branches setup. Go to the dashboard to enable them."
      );
    }

    const branchList = await $replica.runtimeEnvironment.findMany({
      where: {
        projectId: subject.projectId,
        parentEnvironmentId: previewEnvironment.id,
        archivedAt: null,
      },
      select: { branchName: true, paused: true },
    });

    const lines: string[] = [];

    if (branchList.length === 0) {
      lines.push("No preview branches found.");
    } else {
      lines.push(`Found ${branchList.length} preview branch${branchList.length === 1 ? "" : "es"}`);
      lines.push("");
      for (const branch of branchList) {
        const paused = branch.paused ? " (paused)" : "";
        lines.push(`- ${fenceUntrusted(branch.branchName ?? "main", "branch-name")}${paused}`);
      }
    }

    return textResult(lines.join("\n"));
  },
});

export const deploysTools: McpToolDefinition[] = [listDeploys, listPreviewBranches];
