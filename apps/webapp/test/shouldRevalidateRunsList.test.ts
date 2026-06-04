import type { Location, Navigation, ShouldRevalidateFunction } from "@remix-run/react";
import { describe, expect, it } from "vitest";
import {
  isRunsListLoading,
  RUNS_BULK_INSPECTOR_OPEN_VALUE,
  shouldRevalidateRunsList,
} from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs._index/shouldRevalidateRunsList";

const runsUrl = (search: string) =>
  new URL(`http://localhost:3030/orgs/acme/projects/proj/env/dev/runs${search}`);

function args(
  currentSearch: string,
  nextSearch: string,
  defaultShouldRevalidate = true
): Parameters<ShouldRevalidateFunction>[0] {
  return {
    currentUrl: runsUrl(currentSearch),
    nextUrl: runsUrl(nextSearch),
    defaultShouldRevalidate,
    formMethod: undefined,
    formAction: undefined,
    formData: undefined,
    json: undefined,
    actionResult: undefined,
  };
}

describe("shouldRevalidateRunsList", () => {
  it("returns false when only bulk inspector UI params change", () => {
    expect(
      shouldRevalidateRunsList(
        args("?tasks=hello", `?tasks=hello&bulkInspector=${RUNS_BULK_INSPECTOR_OPEN_VALUE}&action=replay&mode=selected`)
      )
    ).toBe(false);
  });

  it("returns false when closing the bulk inspector", () => {
    expect(
      shouldRevalidateRunsList(
        args(`?tasks=hello&bulkInspector=${RUNS_BULK_INSPECTOR_OPEN_VALUE}`, "?tasks=hello")
      )
    ).toBe(false);
  });

  it("returns false when list-data params are reordered", () => {
    expect(
      shouldRevalidateRunsList(args("?tasks=a&runtime=b", "?runtime=b&tasks=a"))
    ).toBe(false);
  });

  it("returns default when list filters and bulk inspector UI params change together", () => {
    expect(
      shouldRevalidateRunsList(args("?tasks=a", `?tasks=b&bulkInspector=${RUNS_BULK_INSPECTOR_OPEN_VALUE}`))
    ).toBe(true);
  });

  it("returns default when list filters change", () => {
    expect(shouldRevalidateRunsList(args("?tasks=hello", "?tasks=world"))).toBe(true);
  });

  it("returns default when pagination params change", () => {
    expect(
      shouldRevalidateRunsList(
        args("?tasks=hello", "?tasks=hello&cursor=abc&direction=forward")
      )
    ).toBe(true);
  });

  it("returns default when the URL is unchanged (explicit revalidate)", () => {
    expect(shouldRevalidateRunsList(args("?tasks=hello", "?tasks=hello"))).toBe(true);
  });

  it("returns default when pathname changes", () => {
    expect(
      shouldRevalidateRunsList({
        ...args("?tasks=hello", "?tasks=hello"),
        nextUrl: new URL("http://localhost:3030/orgs/acme/projects/proj/env/dev/tasks"),
      })
    ).toBe(true);
  });

  it("respects defaultShouldRevalidate when false", () => {
    expect(
      shouldRevalidateRunsList(args("?tasks=hello", "?tasks=world", false))
    ).toBe(false);
  });
});

function makeLocation(search: string): Location {
  const url = runsUrl(search);
  return {
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    state: null,
    key: "test-key",
  };
}

function navigation(
  state: Navigation["state"],
  nextSearch?: string
): Navigation {
  return {
    state,
    location: nextSearch ? makeLocation(nextSearch) : undefined,
    formMethod: undefined,
    formAction: undefined,
    formEncType: undefined,
    formData: undefined,
    json: undefined,
  };
}

describe("isRunsListLoading", () => {
  it("returns false when navigation is idle", () => {
    expect(isRunsListLoading(navigation("idle"), "?tasks=hello")).toBe(false);
  });

  it("returns false when only bulk inspector UI params change", () => {
    expect(
      isRunsListLoading(
        navigation("loading", `?tasks=hello&bulkInspector=${RUNS_BULK_INSPECTOR_OPEN_VALUE}&action=replay`),
        "?tasks=hello"
      )
    ).toBe(false);
  });

  it("returns false when list-data params are reordered", () => {
    expect(
      isRunsListLoading(navigation("loading", "?runtime=b&tasks=a"), "?tasks=a&runtime=b")
    ).toBe(false);
  });

  it("returns true when list filters and bulk inspector UI params change together", () => {
    expect(
      isRunsListLoading(navigation("loading", `?tasks=b&bulkInspector=${RUNS_BULK_INSPECTOR_OPEN_VALUE}`), "?tasks=a")
    ).toBe(true);
  });

  it("returns true when list filters change", () => {
    expect(
      isRunsListLoading(navigation("loading", "?tasks=world"), "?tasks=hello")
    ).toBe(true);
  });

  it("returns true when pagination params change", () => {
    expect(
      isRunsListLoading(
        navigation("loading", "?tasks=hello&cursor=abc&direction=forward"),
        "?tasks=hello"
      )
    ).toBe(true);
  });

  it("returns false when navigation is loading without a target location", () => {
    expect(isRunsListLoading(navigation("loading"), "?tasks=hello")).toBe(false);
  });
});
