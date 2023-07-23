type InputType = { id: string; parentId: string | null };
type OutputType<T> = T & { subtasks?: T[] };

export function taskListToTree<T extends InputType, R extends OutputType<T>>(
  tasks: T[]
): R[] {
  const result: R[] = [];
  const map = new Map<string, T>(tasks.map((v) => [v.id, v]));

  for (const node of tasks) {
    const parent: R | null = node.parentId
      ? (map.get(node.parentId) as R)
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
