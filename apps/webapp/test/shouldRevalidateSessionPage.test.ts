// Unit test: a pure, stable rule for which URL changes skip the session loader.
import type { ShouldRevalidateFunction } from "@remix-run/react";
import { describe, expect, it } from "vitest";
import { shouldRevalidateSessionPage } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.sessions.$sessionParam/shouldRevalidateSessionPage";

const sessionUrl = (search: string, sessionParam = "session_1") =>
  new URL(
    `http://localhost:3030/orgs/acme/projects/proj/env/dev/sessions/${sessionParam}${search}`
  );

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

describe("shouldRevalidateSessionPage", () => {
  it("skips the loader when only the selection changes", () => {
    expect(
      shouldRevalidateSessionPage(args(sessionUrl(""), sessionUrl("?run=run_a&span=s1")))
    ).toBe(false);
    expect(
      shouldRevalidateSessionPage(args(sessionUrl("?run=run_a"), sessionUrl("?run=run_b")))
    ).toBe(false);
    expect(
      shouldRevalidateSessionPage(args(sessionUrl("?run=run_a&span=s1"), sessionUrl("")))
    ).toBe(false);
  });

  it("skips the loader when only a tab or the view changes", () => {
    expect(
      shouldRevalidateSessionPage(args(sessionUrl("?tab=overview"), sessionUrl("?tab=runs")))
    ).toBe(false);
    expect(shouldRevalidateSessionPage(args(sessionUrl(""), sessionUrl("?spanTab=detail")))).toBe(
      false
    );
    expect(
      shouldRevalidateSessionPage(args(sessionUrl("?view=trace"), sessionUrl("?view=conversation")))
    ).toBe(false);
  });

  it("ignores param order", () => {
    expect(
      shouldRevalidateSessionPage(
        args(sessionUrl("?raw=1&view=conversation"), sessionUrl("?view=trace&raw=1"))
      )
    ).toBe(false);
  });

  it("revalidates when another param changes", () => {
    expect(
      shouldRevalidateSessionPage(args(sessionUrl("?run=run_a"), sessionUrl("?run=run_a&raw=1")))
    ).toBe(true);
    expect(
      shouldRevalidateSessionPage(args(sessionUrl("?channel=a"), sessionUrl("?channel=b")))
    ).toBe(true);
  });

  it("revalidates on an explicit revalidate, a form submission or another session", () => {
    expect(
      shouldRevalidateSessionPage(args(sessionUrl("?run=run_a"), sessionUrl("?run=run_a")))
    ).toBe(true);
    expect(
      shouldRevalidateSessionPage(
        args(sessionUrl("?run=run_a"), sessionUrl("?run=run_b"), { formMethod: "POST" })
      )
    ).toBe(true);
    expect(
      shouldRevalidateSessionPage(
        args(sessionUrl("?run=run_a"), sessionUrl("?run=run_b", "session_2"))
      )
    ).toBe(true);
  });

  it("follows the default when it says no", () => {
    expect(
      shouldRevalidateSessionPage(
        args(sessionUrl("?raw=1"), sessionUrl("?raw=2"), { defaultShouldRevalidate: false })
      )
    ).toBe(false);
  });
});
