import { describe, expect, it } from "vitest";
import { getRouteErrorMessage } from "./httpErrors";

describe("getRouteErrorMessage", () => {
  it("returns data.message when present", () => {
    expect(getRouteErrorMessage(500, "Internal Server Error", { message: "boom" })).toBe("boom");
  });

  it("falls back when data is null", () => {
    expect(getRouteErrorMessage(500, "Internal Server Error", null)).toBe(
      "Something went wrong on our end. Please try again later."
    );
  });

  it("falls back when data is undefined", () => {
    expect(getRouteErrorMessage(404, "Not Found", undefined)).toBe(
      "The page you're looking for doesn't exist."
    );
  });

  it("uses a string data body", () => {
    expect(getRouteErrorMessage(400, "Bad Request", "Invalid payload")).toBe("Invalid payload");
  });

  it("falls back when message is missing or empty", () => {
    expect(getRouteErrorMessage(403, "Forbidden", {})).toBe(
      "You don't have permission to access this resource."
    );
    expect(getRouteErrorMessage(403, "Forbidden", { message: "" })).toBe(
      "You don't have permission to access this resource."
    );
  });
});
