type InputType = { id: string; parentId: string | null };
export type OutputType<T> = T & { subtasks?: T[] };

export function taskListToTree<T extends InputType>(
  tasks: T[],
  addSubtasks = true
): OutputType<T>[] {
  if (!addSubtasks) {
    return tasks;
  }

  const result: OutputType<T>[] = [];
  const map = new Map<string, T>(tasks.map((v) => [v.id, v]));

  for (const node of tasks) {
    const parent: OutputType<T> | null = node.parentId
      ? (map.get(node.parentId) as OutputType<T>)
      : null;
    if (parent) {
      if (!parent.subtasks) {
        parent.subtasks = [] as any;
      }
      parent.subtasks!.push(node as any);
    } else {
      result.push(node as any);
    }
  }

  return result;
}
