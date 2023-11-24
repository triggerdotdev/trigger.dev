import { RuntimeEnvironmentType } from "@trigger.dev/database";

const environmentSortOrder: RuntimeEnvironmentType[] = [
  "DEVELOPMENT",
  "PREVIEW",
  "STAGING",
  "PRODUCTION",
];

type SortType = {
  type: RuntimeEnvironmentType;
};

export function sortEnvironments<T extends SortType>(environments: T[]): T[] {
  return environments.sort((a, b) => {
    const aIndex = environmentSortOrder.indexOf(a.type);
    const bIndex = environmentSortOrder.indexOf(b.type);
    return aIndex - bIndex;
  });
}
