import { useTextFilter } from "./useTextFilter";

type Task = {
  id: string;
  friendlyId: string;
  taskIdentifier: string;
  filePath: string;
  triggerSource: string;
};

export function useFilterTasks<T extends Task>({ tasks }: { tasks: T[] }) {
  return useTextFilter<T>({
    items: tasks,
    filter: (task, text) => {
      if (task.taskIdentifier.toLowerCase().includes(text.toLowerCase())) {
        return true;
      }

      if (task.filePath.toLowerCase().includes(text.toLowerCase())) {
        return true;
      }

      if (task.id.toLowerCase().includes(text.toLowerCase())) {
        return true;
      }

      if (task.friendlyId.toLowerCase().includes(text.toLowerCase())) {
        return true;
      }

      if (task.triggerSource === "SCHEDULED" && "scheduled".includes(text.toLowerCase())) {
        return true;
      }

      return false;
    },
  });
}
