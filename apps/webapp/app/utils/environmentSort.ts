import { type RuntimeEnvironmentType } from "@trigger.dev/database";

const environmentSortOrder: RuntimeEnvironmentType[] = [
  "DEVELOPMENT",
  "STAGING",
  "PREVIEW",
  "PRODUCTION",
];

type SortType = {
  type: RuntimeEnvironmentType;
  userName?: string | null;
  lastActivity?: Date | undefined;
  updatedAt?: Date | undefined;
};

export function sortEnvironments<T extends SortType>(
  environments: T[],
  sortOrder?: RuntimeEnvironmentType[]
): T[] {
  const order = sortOrder ?? environmentSortOrder;
  return environments.sort((a, b) => {
    const aIndex = order.indexOf(a.type);
    const bIndex = order.indexOf(b.type);

    const difference = aIndex - bIndex;

    if (difference === 0) {
      if (a.type === "DEVELOPMENT" && b.type === "DEVELOPMENT") {
        // Within the same env type, order by recency: most-recent dev activity
        // first, falling back to updatedAt when there's no recorded activity,
        // then to username when we have no timestamps at all.
        const aTime = (a.lastActivity ?? a.updatedAt)?.getTime();
        const bTime = (b.lastActivity ?? b.updatedAt)?.getTime();

        if (aTime !== undefined && bTime !== undefined) {
          return bTime - aTime;
        }
        if (aTime !== undefined) return -1;
        if (bTime !== undefined) return 1;
      }

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
