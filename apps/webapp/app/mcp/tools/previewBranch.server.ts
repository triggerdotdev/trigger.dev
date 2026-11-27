import { prisma } from "~/db.server";
import {
  branchLookupNames,
  firstBranchMatch,
  resolveMcpSubject,
} from "../gate/resolveSubject.server";
import type { McpIdentity } from "../types";
import { agentFence } from "./format/environments";

/**
 * Like resolveMcpSubject, but a preview branch that can't be resolved (archived or missing)
 * resolves to the preview environment, so the gate checks the right there and the tool can say why.
 */
export async function resolvePreviewBranchSubject(args: unknown, identity: McpIdentity) {
  const subject = await resolveMcpSubject(args, identity);
  const { environment, branch } = (args ?? {}) as { environment?: unknown; branch?: unknown };
  if (subject || environment !== "preview" || typeof branch !== "string") return subject;
  return resolveMcpSubject({ ...(args as object), branch: undefined }, identity);
}

/**
 * Why the named branch can't be used when the subject fell back to the preview parent, else null.
 * `environment` is the subject's row, already loaded by the caller.
 */
export async function previewBranchRefusal(
  environment: { id: string; type: string; parentEnvironmentId: string | null },
  branch: string | undefined
): Promise<string | null> {
  if (branch === undefined || environment.type !== "PREVIEW") return null;
  if (environment.parentEnvironmentId !== null) return null;
  const named = agentFence(branch, "branch-name");
  const found = await firstBranchMatch(branchLookupNames(branch), (branchName) =>
    prisma.runtimeEnvironment.findFirst({
      where: { parentEnvironmentId: environment.id, branchName },
      orderBy: { archivedAt: { sort: "desc", nulls: "first" } },
      select: { archivedAt: true },
    })
  );
  if (!found) return `Preview branch ${named} was not found in this project; nothing changed.`;
  if (found.archivedAt) return `Preview branch ${named} is archived; nothing changed.`;
  return `Preview branch ${named} changed while this call was being prepared; nothing changed. Call the tool again.`;
}
