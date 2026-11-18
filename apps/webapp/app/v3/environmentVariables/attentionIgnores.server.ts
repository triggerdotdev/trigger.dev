import {
  boundedIn,
  Prisma,
  type EnvironmentVariableIgnoreReason,
  type PrismaClient,
  type RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import type { AttentionIgnoreItem, IgnorableAttentionKind } from "./attention";
import { findTargetEnvironments } from "./targetEnvironments.server";
import { findRefusedEnvironments } from "../writableEnvironments";

const REASONS: Record<IgnorableAttentionKind, EnvironmentVariableIgnoreReason> = {
  empty: "EMPTY",
  missing: "MISSING",
  oidc: "OIDC",
};

const KEY_NOT_FOUND =
  "Nothing was changed. A key wasn't found in this project. It may have been deleted.";

export type AttentionIgnoreResult =
  | { success: true; changed: number }
  | { success: false; error: string };

/**
 * Ignores reasons on the needs attention page (`ignore`), or stops ignoring them (`unignore`).
 * Every item is checked before anything is written: its environment has to be one of the
 * project's, not archived, and writable by this role and user, and its variable one of the
 * project's. One refused item refuses the whole request. The ignores are the team's: one person
 * ignores a reason and nobody on the project sees it until someone undoes it.
 */
export async function setAttentionIgnores(
  prisma: PrismaClient,
  {
    projectId,
    userId,
    action,
    items,
    canWrite,
  }: {
    projectId: string;
    userId: string;
    action: "ignore" | "unignore";
    items: AttentionIgnoreItem[];
    canWrite: (type: RuntimeEnvironmentType) => boolean;
  }
): Promise<AttentionIgnoreResult> {
  const unique = [
    ...new Map(
      items.map((item) => [`${item.environmentId}:${item.variableId}:${item.reason}`, item])
    ).values(),
  ];
  if (unique.length === 0) {
    return { success: false, error: "Select at least one reason." };
  }

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null, organization: { members: { some: { userId } } } },
    select: { id: true },
  });
  if (!project) {
    return { success: false, error: "Project not found" };
  }

  const environmentIds = unique.map((item) => item.environmentId);
  const environments = await findTargetEnvironments(prisma, projectId, environmentIds);
  const refused = findRefusedEnvironments(environments, environmentIds, userId, canWrite);
  if (refused.length > 0) {
    if (refused.some((r) => r.reason === "notFound")) {
      return {
        success: false,
        error:
          "Nothing was changed. An environment wasn't found in this project. It may be an archived branch.",
      };
    }
    // Names each refused environment, as batch delete's refusal does.
    const names = [
      ...new Set(
        refused.flatMap((r) => (r.reason === "notFound" ? [] : environmentFullTitle(r.environment)))
      ),
    ];
    return {
      success: false,
      error: `You can't change what's ignored in ${new Intl.ListFormat("en", { type: "conjunction" }).format(names)}.`,
    };
  }

  const variableIds = [...new Set(unique.map((item) => item.variableId))];
  const variables = await prisma.environmentVariable.findMany({
    where: { projectId, id: { in: boundedIn(variableIds) } },
    select: { id: true },
  });
  if (variables.length !== variableIds.length) {
    return {
      success: false,
      error: KEY_NOT_FOUND,
    };
  }

  // One statement each way, so a request is written whole or not at all.
  if (action === "ignore") {
    try {
      const { count } = await prisma.environmentVariableIgnore.createMany({
        data: unique.map((item) => ({
          projectId,
          environmentId: item.environmentId,
          variableId: item.variableId,
          reason: REASONS[item.reason],
          createdById: userId,
        })),
        // Ignored already (by someone else, or a second click): keeps who ignored it first.
        skipDuplicates: true,
      });
      return { success: true, changed: count };
    } catch (error) {
      // A key deleted since the checks above.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
        return { success: false, error: KEY_NOT_FOUND };
      }
      throw error;
    }
  }

  const { count } = await prisma.environmentVariableIgnore.deleteMany({
    where: {
      projectId,
      OR: unique.map((item) => ({
        environmentId: item.environmentId,
        variableId: item.variableId,
        reason: REASONS[item.reason],
      })),
    },
  });
  return { success: true, changed: count };
}
