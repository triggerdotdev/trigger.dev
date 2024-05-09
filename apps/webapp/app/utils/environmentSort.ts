import { RuntimeEnvironmentType } from "@trigger.dev/database";

const environmentSortOrder: RuntimeEnvironmentType[] = [
  "DEVELOPMENT",
  "PREVIEW",
  "STAGING",
  "PRODUCTION",
];

type SortType = {
  type: RuntimeEnvironmentType;
  userName?: string | null;
};

export function sortEnvironments<T extends SortType>(environments: T[]): T[] {
  return environments.sort((a, b) => {
    const aIndex = environmentSortOrder.indexOf(a.type);
    const bIndex = environmentSortOrder.indexOf(b.type);

    const difference = aIndex - bIndex;

    if (difference === 0) {
      //same environment so sort by name
      const usernameA = a.userName || "";
      const usernameB = b.userName || "";
      return usernameA.localeCompare(usernameB);
    }

    return difference;
  });
}
