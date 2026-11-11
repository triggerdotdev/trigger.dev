import { describe, expect, it } from "vitest";
import {
  ALL_BRANCHES,
  availableEnvironmentVariablesFilters,
  canSortEnvironmentVariablesView,
  listViewSearch,
  parseEnvironmentVariablesFilter,
  selectEnvironmentVariablesFilter,
} from "~/v3/environmentVariables/environmentFilter";

const base = { parentEnvironmentId: null, branchName: null };
const dev = { id: "dev", type: "DEVELOPMENT" as const, ...base };
const staging = { id: "stg", type: "STAGING" as const, ...base };
const prod = { id: "prod", type: "PRODUCTION" as const, ...base };
const preview = { id: "preview", type: "PREVIEW" as const, ...base };
const branchA = {
  id: "branch-a",
  type: "PREVIEW" as const,
  parentEnvironmentId: "preview",
  branchName: "feature/a",
};
const branchB = {
  id: "branch-b",
  type: "PREVIEW" as const,
  parentEnvironmentId: "preview",
  branchName: "feature/b",
};
const branchC = {
  id: "branch-c",
  type: "PREVIEW" as const,
  parentEnvironmentId: "preview",
  branchName: "feature/c",
};
const devBranch = {
  id: "dev-branch",
  type: "DEVELOPMENT" as const,
  parentEnvironmentId: "dev",
  branchName: "eric",
};

const environments = [dev, devBranch, staging, preview, branchA, branchB, prod];

describe("selectEnvironmentVariablesFilter", () => {
  it("defaults to the current environment's type", () => {
    expect(
      selectEnvironmentVariablesFilter({ environments, currentEnvironmentId: "prod" })
    ).toEqual({ filter: "prod", environmentIds: ["prod"] });
    expect(selectEnvironmentVariablesFilter({ environments, currentEnvironmentId: "dev" })).toEqual(
      {
        filter: "dev",
        environmentIds: ["dev"],
      }
    );
  });

  // Catches: Preview picked from Prod showing only the base, with no branch values.
  it("lists the Preview base and every branch when Preview is picked from another environment", () => {
    expect(
      selectEnvironmentVariablesFilter({
        environments,
        requested: "preview",
        currentEnvironmentId: "prod",
      })
    ).toEqual({
      filter: "preview",
      environmentIds: ["preview", "branch-a", "branch-b"],
      branchEnvironmentIds: [],
    });
  });

  it("narrows Preview to the base and the requested branch", () => {
    expect(
      selectEnvironmentVariablesFilter({
        environments,
        requested: "preview",
        requestedBranches: ["feature/b"],
        currentEnvironmentId: "prod",
      })
    ).toEqual({
      filter: "preview",
      environmentIds: ["preview", "branch-b"],
      branchEnvironmentIds: ["branch-b"],
    });
  });

  it("narrows Preview to the base and several requested branches", () => {
    expect(
      selectEnvironmentVariablesFilter({
        environments: [...environments, branchC],
        requested: "preview",
        requestedBranches: ["feature/c", "feature/a"],
        currentEnvironmentId: "prod",
      })
    ).toEqual({
      filter: "preview",
      environmentIds: ["preview", "branch-a", "branch-c"],
      branchEnvironmentIds: ["branch-a", "branch-c"],
    });
  });

  // Catches: one unknown name in the URL hiding the known branches next to it.
  it("ignores unknown branch names next to known ones", () => {
    expect(
      selectEnvironmentVariablesFilter({
        environments,
        requested: "preview",
        requestedBranches: ["nonsense", "feature/b"],
        currentEnvironmentId: "prod",
      })
    ).toEqual({
      filter: "preview",
      environmentIds: ["preview", "branch-b"],
      branchEnvironmentIds: ["branch-b"],
    });
  });

  it("lists the requested branches instead of the current one on a branch URL", () => {
    expect(
      selectEnvironmentVariablesFilter({
        environments,
        requested: "preview",
        requestedBranches: ["feature/a", "feature/b"],
        currentEnvironmentId: "branch-a",
      }).branchEnvironmentIds
    ).toEqual(["branch-a", "branch-b"]);
    expect(
      selectEnvironmentVariablesFilter({
        environments,
        requested: "preview",
        requestedBranches: ["feature/b"],
        currentEnvironmentId: "branch-a",
      }).branchEnvironmentIds
    ).toEqual(["branch-b"]);
  });

  it("defaults to the current branch on a preview branch URL", () => {
    const expected = {
      filter: "preview",
      environmentIds: ["preview", "branch-a"],
      branchEnvironmentIds: ["branch-a"],
    };

    expect(
      selectEnvironmentVariablesFilter({ environments, currentEnvironmentId: "branch-a" })
    ).toEqual(expected);
    expect(
      selectEnvironmentVariablesFilter({
        environments,
        requested: "preview",
        currentEnvironmentId: "branch-a",
      })
    ).toEqual(expected);
    // An unknown branch name is treated as absent.
    expect(
      selectEnvironmentVariablesFilter({
        environments,
        requested: "preview",
        requestedBranches: ["nonsense"],
        currentEnvironmentId: "branch-a",
      })
    ).toEqual(expected);
  });

  it("lists every branch for an unknown branch name off a branch URL", () => {
    expect(
      selectEnvironmentVariablesFilter({
        environments,
        requested: "preview",
        requestedBranches: ["nonsense"],
        currentEnvironmentId: "prod",
      }).environmentIds
    ).toEqual(["preview", "branch-a", "branch-b"]);
  });

  // Catches: a branch URL with no way to see every branch.
  it("lists every branch for ALL_BRANCHES, even on a branch URL", () => {
    expect(
      selectEnvironmentVariablesFilter({
        environments,
        requested: "preview",
        requestedBranches: [ALL_BRANCHES],
        currentEnvironmentId: "branch-a",
      })
    ).toEqual({
      filter: "preview",
      environmentIds: ["preview", "branch-a", "branch-b"],
      branchEnvironmentIds: [],
    });
  });

  it("ignores the branch for other filters", () => {
    expect(
      selectEnvironmentVariablesFilter({
        environments,
        requested: "prod",
        requestedBranches: ["feature/a"],
        currentEnvironmentId: "branch-a",
      })
    ).toEqual({ filter: "prod", environmentIds: ["prod"] });
  });

  it("keeps Dev to the base plus the current dev branch", () => {
    expect(
      selectEnvironmentVariablesFilter({ environments, currentEnvironmentId: "dev-branch" })
    ).toEqual({ filter: "dev", environmentIds: ["dev", "dev-branch"] });
    expect(
      selectEnvironmentVariablesFilter({
        environments,
        requested: "dev",
        currentEnvironmentId: "prod",
      })
    ).toEqual({ filter: "dev", environmentIds: ["dev"] });
  });

  it("drops the current branch when another type is picked", () => {
    expect(
      selectEnvironmentVariablesFilter({
        environments,
        requested: "prod",
        currentEnvironmentId: "branch-a",
      })
    ).toEqual({ filter: "prod", environmentIds: ["prod"] });
  });

  it("keeps every environment for all", () => {
    expect(
      selectEnvironmentVariablesFilter({
        environments,
        requested: "all",
        currentEnvironmentId: "prod",
      })
    ).toEqual({
      filter: "all",
      environmentIds: ["dev", "dev-branch", "stg", "preview", "branch-a", "branch-b", "prod"],
    });
  });

  it("treats a type the project doesn't have like no request", () => {
    expect(
      selectEnvironmentVariablesFilter({
        environments: [dev, prod],
        requested: "stg",
        currentEnvironmentId: "prod",
      })
    ).toEqual({ filter: "prod", environmentIds: ["prod"] });
  });

  // Catches: an archived branch URL listing every environment instead of Preview.
  it("uses the current environment's type when it isn't in the list", () => {
    expect(
      selectEnvironmentVariablesFilter({
        environments,
        currentEnvironmentId: "archived-branch",
        currentEnvironmentType: "PREVIEW",
      })
    ).toEqual({
      filter: "preview",
      environmentIds: ["preview", "branch-a", "branch-b"],
      branchEnvironmentIds: [],
    });
    // A requested filter still wins.
    expect(
      selectEnvironmentVariablesFilter({
        environments,
        requested: "prod",
        currentEnvironmentType: "PREVIEW",
      })
    ).toEqual({ filter: "prod", environmentIds: ["prod"] });
    // A type the project no longer has falls back to all.
    expect(
      selectEnvironmentVariablesFilter({
        environments: [dev, prod],
        currentEnvironmentType: "PREVIEW",
      })
    ).toEqual({ filter: "all", environmentIds: ["dev", "prod"] });
  });

  it("falls back to all without a current environment", () => {
    expect(selectEnvironmentVariablesFilter({ environments: [dev, prod] })).toEqual({
      filter: "all",
      environmentIds: ["dev", "prod"],
    });
    expect(
      selectEnvironmentVariablesFilter({ environments: [dev, prod], currentEnvironmentId: "gone" })
    ).toEqual({ filter: "all", environmentIds: ["dev", "prod"] });
  });
});

describe("canSortEnvironmentVariablesView", () => {
  const canSort = (
    args: Omit<Parameters<typeof selectEnvironmentVariablesFilter>[0], "environments">
  ) => canSortEnvironmentVariablesView(selectEnvironmentVariablesFilter({ environments, ...args }));

  // Catches: the sort offered where it would read every environment's or every branch's values.
  it("allows one environment, or the Preview base with exactly one branch", () => {
    expect(canSort({ currentEnvironmentId: "prod" })).toBe(true);
    expect(canSort({ requested: "stg", currentEnvironmentId: "prod" })).toBe(true);
    expect(
      canSort({
        requested: "preview",
        requestedBranches: ["feature/a"],
        currentEnvironmentId: "prod",
      })
    ).toBe(true);
    // A branch URL lists the base and that branch.
    expect(canSort({ currentEnvironmentId: "branch-a" })).toBe(true);

    expect(canSort({ requested: "all", currentEnvironmentId: "prod" })).toBe(false);
    expect(canSort({ requested: "preview", currentEnvironmentId: "prod" })).toBe(false);
    expect(
      canSort({
        requested: "preview",
        requestedBranches: ["feature/a", "feature/b"],
        currentEnvironmentId: "prod",
      })
    ).toBe(false);
    expect(
      canSort({
        requested: "preview",
        requestedBranches: [ALL_BRANCHES],
        currentEnvironmentId: "branch-a",
      })
    ).toBe(false);
    // Dev opened on a dev branch lists two environments.
    expect(canSort({ currentEnvironmentId: "dev-branch" })).toBe(false);
  });

  it("treats all as unsortable even with one environment, and Preview without branches as one", () => {
    const view = (environments: (typeof prod)[], requested: "all" | "preview") =>
      canSortEnvironmentVariablesView(
        selectEnvironmentVariablesFilter({ environments, requested })
      );
    expect(view([prod], "all")).toBe(false);
    expect(view([preview, prod], "preview")).toBe(true);
  });
});

describe("parseEnvironmentVariablesFilter", () => {
  it("accepts the known values and nothing else", () => {
    expect(parseEnvironmentVariablesFilter("preview")).toBe("preview");
    expect(parseEnvironmentVariablesFilter("all")).toBe("all");
    expect(parseEnvironmentVariablesFilter("nonsense")).toBeUndefined();
    expect(parseEnvironmentVariablesFilter(undefined)).toBeUndefined();
  });
});

describe("availableEnvironmentVariablesFilters", () => {
  it("offers all, then only the types the project has", () => {
    expect(availableEnvironmentVariablesFilters(environments)).toEqual([
      "all",
      "dev",
      "stg",
      "preview",
      "prod",
    ]);
    expect(availableEnvironmentVariablesFilters([dev, prod])).toEqual(["all", "dev", "prod"]);
  });
});

describe("listViewSearch", () => {
  // Catches: an action redirect that drops the view, or carries unrelated params along.
  it("keeps env, every branch, search and page, and drops the rest", () => {
    expect(
      listViewSearch(
        "https://x.test/p?env=preview&branch=feature%2Fa&branch=b&search=API&page=2&junk=1&_data=r"
      )
    ).toBe("?env=preview&branch=feature%2Fa&branch=b&search=API&page=2");
  });

  it("is empty without list params", () => {
    expect(listViewSearch("https://x.test/p?junk=1&env=")).toBe("");
    expect(listViewSearch(new URL("https://x.test/p"))).toBe("");
  });
});
