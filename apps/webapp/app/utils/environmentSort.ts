import { type RuntimeEnvironmentType } from "@trigger.dev/database";

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

type FilterableEnvironment =
  | {
      type: RuntimeEnvironmentType;
      orgMemberId?: string;
    }
  | {
      type: RuntimeEnvironmentType;
      //intentionally vague so we can match anything
      orgMember?: Record<string, any>;
    };

export function filterOrphanedEnvironments<T extends FilterableEnvironment>(
  environments: T[]
): T[] {
  return environments.filter((environment) => {
    if (environment.type !== "DEVELOPMENT") return true;

    if ("orgMemberId" in environment) {
      return !!environment.orgMemberId;
    }

    if ("orgMember" in environment) {
      return !!environment.orgMember;
    }

    return false;
  });
}

export function onlyDevEnvironments<T extends FilterableEnvironment>(environments: T[]): T[] {
  return environments.filter((e) => e.type === "DEVELOPMENT");
}

export function exceptDevEnvironments<T extends FilterableEnvironment>(environments: T[]): T[] {
  return environments.filter((e) => e.type !== "DEVELOPMENT");
}
