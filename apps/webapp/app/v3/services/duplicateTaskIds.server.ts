import { ServiceValidationError } from "./common.server";

type TaskIdResource = {
  id: string;
  filePath?: string;
  exportName?: string;
};

/**
 * Returns the set of task ids that are defined more than once. All task types
 * (regular tasks, scheduled tasks, agents, etc.) share a single id namespace,
 * so a schedule and a regular task that use the same id count as a duplicate.
 */
export function findDuplicateTaskIds(tasks: Array<TaskIdResource>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const task of tasks) {
    if (seen.has(task.id)) {
      duplicates.add(task.id);
    } else {
      seen.add(task.id);
    }
  }

  return Array.from(duplicates);
}

/**
 * Throws a customer-facing {@link ServiceValidationError} (HTTP 400) if any
 * task id is defined more than once, naming each offending id and the files it
 * was found in.
 */
export function assertNoDuplicateTaskIds(tasks: Array<TaskIdResource>): void {
  const duplicateTaskIds = findDuplicateTaskIds(tasks);

  if (duplicateTaskIds.length === 0) {
    return;
  }

  const details = duplicateTaskIds
    .map((id) => {
      const locations = tasks
        .filter((task) => task.id === id)
        .map((task) => task.filePath ?? "unknown file")
        .join(", ");

      return `"${id}" (defined in ${locations})`;
    })
    .join("; ");

  throw new ServiceValidationError(
    `Duplicate task ids detected: ${details}. Each task must have a unique id across all task types (including scheduled tasks). Please rename one of them.`,
    400
  );
}
