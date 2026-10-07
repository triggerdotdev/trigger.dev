import type { ShouldRevalidateFunction } from "@remix-run/react";
import { describe, expect, it } from "vitest";
import { shouldRevalidateRunPage } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam/shouldRevalidateRunPage";

const runUrl = (search: string, runParam = "run_1") =>
  new URL(`http://localhost:3030/orgs/acme/projects/proj/env/dev/runs/${runParam}${search}`);

function args(
  currentUrl: URL,
  nextUrl: URL,
  overrides: Partial<Parameters<ShouldRevalidateFunction>[0]> = {}
): Parameters<ShouldRevalidateFunction>[0] {
  return {
    currentUrl,
    nextUrl,
    defaultShouldRevalidate: true,
    formMethod: undefined,
    formAction: undefined,
    formData: undefined,
    json: undefined,
    actionResult: undefined,
    ...overrides,
  };
}

describe("shouldRevalidateRunPage", () => {
  it("skips the loader when only the span changes", () => {
    expect(shouldRevalidateRunPage(args(runUrl("?span=a"), runUrl("?span=b")))).toBe(false);
    expect(shouldRevalidateRunPage(args(runUrl(""), runUrl("?span=b")))).toBe(false);
    expect(
      shouldRevalidateRunPage(
        args(runUrl("?showDebug=true&span=a"), runUrl("?span=b&showDebug=true"))
      )
    ).toBe(false);
  });

  it("revalidates when another param changes", () => {
    expect(shouldRevalidateRunPage(args(runUrl("?span=a"), runUrl("?span=a&showDebug=true")))).toBe(
      true
    );
  });

  it("defers to the default for an explicit revalidate of the same URL", () => {
    const url = runUrl("?span=a");
    expect(shouldRevalidateRunPage(args(url, url))).toBe(true);
    expect(shouldRevalidateRunPage(args(url, url, { defaultShouldRevalidate: false }))).toBe(false);
  });

  it("revalidates when moving to another run", () => {
    expect(shouldRevalidateRunPage(args(runUrl("?span=a"), runUrl("?span=b", "run_2")))).toBe(true);
  });

  it("defers to the default after a form submission", () => {
    expect(
      shouldRevalidateRunPage(args(runUrl("?span=a"), runUrl("?span=b"), { formMethod: "POST" }))
    ).toBe(true);
  });
});
