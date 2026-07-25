import { describe, expect, it } from "vitest";
import { InsertError } from "./errors.js";

describe("InsertError.rawMessage", () => {
  const rawMessage =
    'Code: 117. DB::Exception: Cannot parse JSON object here: {"secret":"customer-payload"}: (at row 3)';

  it("is readable by the recovery path", () => {
    expect(new InsertError("Cannot parse JSON object here", { rawMessage }).rawMessage).toBe(
      rawMessage
    );
  });

  it("stays out of anything that serializes own enumerable properties", () => {
    const error = new InsertError("Cannot parse JSON object here", { rawMessage });

    expect(Object.keys(error)).not.toContain("rawMessage");
    expect(JSON.stringify(error)).not.toContain("customer-payload");
    expect(JSON.stringify({ ...error })).not.toContain("customer-payload");
    expect(error.toString()).not.toContain("customer-payload");
  });

  it("is absent rather than undefined-valued when no raw message is supplied", () => {
    const error = new InsertError("boom");

    expect(error.rawMessage).toBeUndefined();
    expect(Object.keys(error)).not.toContain("rawMessage");
  });
});
