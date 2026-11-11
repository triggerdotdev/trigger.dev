import { describe, expect, it } from "vitest";
import {
  activeInlineValueEdit,
  deleteValueDialog,
  keyPanelEnvironments,
  listedPreviewBase,
  keyPanelViewSearch,
  navigationKeepsKeyPanel,
  navigationKeepsList,
} from "~/v3/environmentVariables/environmentVariableKey";

describe("keyPanelEnvironments", () => {
  // Catches: a row per preview branch in the panel's Environments section, or rows out of the
  // filter's order.
  it("lists the environments that aren't branches, in the filter's order", () => {
    const env = (id: string, type: "DEVELOPMENT" | "STAGING" | "PREVIEW" | "PRODUCTION") => ({
      id,
      type,
      parentEnvironmentId: null as string | null,
    });

    expect(
      keyPanelEnvironments([
        env("prod", "PRODUCTION"),
        { ...env("branch", "PREVIEW"), parentEnvironmentId: "preview" },
        env("preview", "PREVIEW"),
        env("dev", "DEVELOPMENT"),
        env("stg", "STAGING"),
      ]).map((environment) => environment.id)
    ).toEqual(["dev", "stg", "preview", "prod"]);
  });
});

describe("key panel search params", () => {
  const url =
    "https://example.com/list/key/A?env=prod&search=db&page=2&branchSearch=audit&branchPage=3&environmentId=env_1&fillKey=1";

  // Catches: the panel's branch search or page lost when an action returns to the panel, or
  // the create dialog's own params kept after it closes.
  it("keeps the list's and the panel's params, and drops the rest", () => {
    expect(keyPanelViewSearch(url)).toBe(
      "?env=prod&search=db&page=2&branchSearch=audit&branchPage=3"
    );
  });
});

describe("which loaders a navigation can skip", () => {
  const page = { organizationSlug: "acme", projectParam: "shop", envParam: "prod" };
  const origin = "https://example.com/orgs/acme/projects/shop/env";
  const navigation = (
    from: string,
    to: string,
    currentParams: Record<string, string> = { ...page, keyParam: "A" },
    nextParams: Record<string, string> = currentParams
  ) => ({
    currentUrl: new URL(`${origin}/${from}`),
    nextUrl: new URL(`${origin}/${to}`),
    currentParams,
    nextParams,
  });
  const panel = "prod/environment-variables/key/A";

  // Catches: the 50-key list loading again on every branches page or branches search.
  it("keeps the list when only the panel's branches page or search changes", () => {
    expect(
      navigationKeepsList(navigation(`${panel}?env=all`, `${panel}?env=all&branchPage=2`))
    ).toBe(true);
    expect(
      navigationKeepsList(navigation(`${panel}?branchPage=2`, `${panel}?branchSearch=audit`))
    ).toBe(true);
  });

  // Catches: a stale list after its own filter, search, sort or page changed next to the panel's params.
  it("reloads the list when its own params change", () => {
    for (const to of ["env=stg", "search=db", "sort=updated", "page=2", "env=all&branch=main"]) {
      expect(
        navigationKeepsList(navigation(`${panel}?env=all`, `${panel}?${to}&branchPage=2`))
      ).toBe(false);
    }
  });

  // Catches: the previous environment's (or project's) list kept under the new URL when the
  // environment is switched from a panel URL that had a branches page or search.
  it("reloads the list when the environment, project or organization changes", () => {
    const from = `${panel}?branchPage=2`;
    expect(
      navigationKeepsList(
        navigation(from, "stg/environment-variables", undefined, { ...page, envParam: "stg" })
      )
    ).toBe(false);
    expect(
      navigationKeepsList(
        navigation(from, panel, undefined, { ...page, projectParam: "blog", keyParam: "A" })
      )
    ).toBe(false);
    expect(
      navigationKeepsList(
        navigation(from, panel, undefined, { ...page, organizationSlug: "other", keyParam: "A" })
      )
    ).toBe(false);
  });

  // Catches: the panel loading again on every list search, filter, sort or page.
  it("keeps the panel when only the list's params change", () => {
    expect(
      navigationKeepsKeyPanel(
        navigation(`${panel}?branchPage=2`, `${panel}?branchPage=2&search=db&page=3`)
      )
    ).toBe(true);
  });

  // Catches: another key's, project's or organization's panel kept under the new URL.
  it("reloads the panel when its key, its own params or the project changes", () => {
    const from = `${panel}?env=all`;
    expect(navigationKeepsKeyPanel(navigation(from, `${panel}?env=all&branchPage=2`))).toBe(false);
    expect(
      navigationKeepsKeyPanel(
        navigation(from, "prod/environment-variables/key/B?env=prod", undefined, {
          ...page,
          keyParam: "B",
        })
      )
    ).toBe(false);
    for (const changed of [{ projectParam: "blog" }, { organizationSlug: "other" }]) {
      expect(
        navigationKeepsKeyPanel(
          navigation(from, `${panel}?env=prod`, undefined, { ...page, keyParam: "A", ...changed })
        )
      ).toBe(false);
    }
  });
});

describe("deleteValueDialog", () => {
  const branch = { type: "PREVIEW" as const, branchName: "feat/x" };

  // Catches: the override dialog on a value that isn't a branch's, or the delete dialog on one
  // that is.
  it("uses the override dialog only for a Preview branch's value", () => {
    expect(deleteValueDialog({ type: "PRODUCTION", branchName: null }, "set")).toEqual({
      kind: "delete",
    });
    expect(deleteValueDialog({ type: "PREVIEW", branchName: null }, "set")).toEqual({
      kind: "delete",
    });
    expect(deleteValueDialog(branch, "unknown").kind).toBe("removeOverride");
  });

  // Catches: a branch said to fall back to a Preview value that doesn't exist, or the reverse.
  it("says what the branch is left with from the Preview base", () => {
    expect(deleteValueDialog(branch, "set")).toEqual({
      kind: "removeOverride",
      afterRemoval: "previewValue",
    });
    expect(deleteValueDialog(branch, "unset")).toEqual({
      kind: "removeOverride",
      afterRemoval: "noValue",
    });
    expect(deleteValueDialog(branch, "unknown")).toEqual({
      kind: "removeOverride",
      afterRemoval: "unknown",
    });
  });
});

describe("listedPreviewBase", () => {
  const rows = [
    { key: "A", environment: { id: "preview" } },
    { key: "A", environment: { id: "branch" } },
    { key: "B", environment: { id: "branch" } },
  ];

  // Catches: guessing a key has no Preview value when the list doesn't show the Preview
  // environment at all.
  it("is unknown when the Preview environment isn't listed", () => {
    expect(listedPreviewBase("A", rows, "preview", ["branch"])).toBe("unknown");
    expect(listedPreviewBase("A", rows, undefined, ["branch"])).toBe("unknown");
  });

  it("reads the key's Preview row when the Preview environment is listed", () => {
    expect(listedPreviewBase("A", rows, "preview", ["preview", "branch"])).toBe("set");
    expect(listedPreviewBase("B", rows, "preview", ["preview", "branch"])).toBe("unset");
  });
});

describe("activeInlineValueEdit", () => {
  const noValue = () => false;
  const hasValue = (id: string) => id === "env_staging";

  // Catches: Set on an environment with no value leaving an editor open after the save, because
  // the reloaded row's new value opened as an edit of it.
  it("ends a set once its environment has a value", () => {
    const set = { key: "API_URL", environmentId: "env_staging", kind: "set" as const };
    expect(activeInlineValueEdit(set, "API_URL", noValue)).toEqual(set);
    expect(activeInlineValueEdit(set, "API_URL", hasValue)).toBeNull();
  });

  // Catches: an edit of an existing value closing as soon as it opens.
  it("keeps an edit of a value that exists", () => {
    const edit = { key: "API_URL", environmentId: "env_staging", kind: "edit" as const };
    expect(activeInlineValueEdit(edit, "API_URL", hasValue)).toEqual(edit);
  });

  // Catches: an edit started on one key's panel showing on the next key's panel.
  it("drops an edit held for another key", () => {
    const edit = { key: "API_URL", environmentId: "env_staging", kind: "edit" as const };
    expect(activeInlineValueEdit(edit, "DATABASE_URL", hasValue)).toBeNull();
    expect(activeInlineValueEdit(null, "API_URL", hasValue)).toBeNull();
  });
});
