import {
  boundedIn,
  type PrismaClientOrTransaction,
  type RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import type { RefusedEnvironment, WriteCheckEnvironment } from "../writableEnvironments";
import type { DeleteEnvironmentVariableValue } from "./repository";

// How many keys a refusal names before it counts the rest.
const REFUSAL_NAMED_KEYS = 5;

type RefusalEnvironment = WriteCheckEnvironment & {
  type: RuntimeEnvironmentType;
  branchName: string | null;
};

/**
 * Why a batch delete was refused: what was refused and why, for every refused environment. The
 * keys come from this project's variables, never from the submission.
 */
export async function batchDeleteRefusalMessage(
  prisma: PrismaClientOrTransaction,
  projectId: string,
  values: DeleteEnvironmentVariableValue[],
  refused: RefusedEnvironment<RefusalEnvironment>[]
): Promise<string> {
  const notFoundIds = new Set(refused.flatMap((r) => (r.reason === "notFound" ? r.id : [])));
  const notFoundVariableIds = [
    ...new Set(values.flatMap((v) => (notFoundIds.has(v.environmentId) ? v.id : []))),
  ];
  const notFoundKeys =
    notFoundVariableIds.length > 0
      ? (
          await prisma.environmentVariable.findMany({
            where: { projectId, id: { in: boundedIn(notFoundVariableIds) } },
            select: { key: true },
            orderBy: { key: "asc" },
          })
        ).map((variable) => variable.key)
      : [];

  const reasons = refused.flatMap((r) => {
    switch (r.reason) {
      case "notFound":
        return [];
      case "noPermission":
        return `You don't have permission to delete environment variables in ${environmentFullTitle(r.environment)}.`;
      case "notOwner":
        return "A Development environment that belongs to another member isn't writable by you.";
    }
  });
  if (notFoundIds.size > 0) {
    const named = notFoundKeys.slice(0, REFUSAL_NAMED_KEYS).join(", ");
    const more = notFoundKeys.length - REFUSAL_NAMED_KEYS;
    reasons.push(
      notFoundKeys.length === 0
        ? "A selected value's environment wasn't found in this project."
        : `The environment of ${named}${more > 0 ? ` and ${more} more` : ""} wasn't found. It may be an archived branch.`
    );
  }

  return `Nothing was deleted. ${[...new Set(reasons)].join(" ")}`;
}
