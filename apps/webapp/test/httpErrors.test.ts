import { describe, expect, it } from "vitest";
import { throwNotFound } from "~/utils/httpErrors";

describe("throwNotFound", () => {
  it("throws a Response with status 404 and the provided statusText", () => {
    let thrown: unknown;
    try {
      throwNotFound("Environment not found");
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
    expect((thrown as Response).statusText).toBe("Environment not found");
  });

  it("passes through whatever statusText the caller provides", () => {
    let thrown: unknown;
    try {
      throwNotFound("Project not found");
    } catch (e) {
      thrown = e;
    }

    expect((thrown as Response).statusText).toBe("Project not found");
  });
});
