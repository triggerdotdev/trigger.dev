import { ClickHouseError, parseError } from "@clickhouse/client";
import { describe, expect, it } from "vitest";
import { clickhouseErrorDescriptor, toInsertError } from "./client.js";
import { InsertError, insertErrorServerText, insertErrorType } from "./errors.js";

const rawMessage =
  'Code: 117. DB::Exception: Cannot parse JSON object here: {"secret":"customer-payload"}: (at row 3) (INCORRECT_DATA) (version 26.2.1.1)';

describe("patched ClickHouseError.rawMessage", () => {
  it("carries the untruncated text so the recovery path can read the row hint", () => {
    const error = parseError(rawMessage);

    expect(error).toBeInstanceOf(ClickHouseError);
    expect((error as ClickHouseError).rawMessage).toContain("at row 3");
  });

  it("stays out of anything that serializes own enumerable properties", () => {
    const error = parseError(rawMessage);

    expect(Object.keys(error)).not.toContain("rawMessage");
    expect(JSON.stringify(error)).not.toContain("customer-payload");
    expect(JSON.stringify({ ...error })).not.toContain("customer-payload");
  });
});

describe("ClickHouse error logging", () => {
  it("keeps driver message and row fragments out of the log descriptor", () => {
    const error = parseError(rawMessage);
    const originalMessage = error.message;
    const descriptor = clickhouseErrorDescriptor(error);

    expect(descriptor).toEqual({
      name: "ClickHouseError",
      code: "117",
      type: "INCORRECT_DATA",
    });
    expect(JSON.stringify(descriptor)).not.toContain("customer-payload");
    expect(error.message).toBe(originalMessage);
    expect((error as ClickHouseError).rawMessage).toBe(rawMessage);
  });

  it("does not throw when an error property getter throws", () => {
    const error = Object.create(Error.prototype);
    Object.defineProperties(error, {
      name: { get: () => "HostileError" },
      code: {
        get() {
          throw new Error("private-code");
        },
      },
      message: {
        get() {
          throw new Error("private-message");
        },
      },
      stack: {
        get() {
          throw new Error("private-stack");
        },
      },
    });

    expect(clickhouseErrorDescriptor(error)).toEqual({ name: "HostileError" });
  });
});

describe("InsertError.rawMessage", () => {
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

describe("InsertError.clickhouseErrorType", () => {
  it("carries the ClickHouse error type when the server rejected the insert", () => {
    const error = new InsertError("No such column attributes_input in table", {
      clickhouseErrorType: "NO_SUCH_COLUMN_IN_TABLE",
    });

    expect(error.clickhouseErrorType).toBe("NO_SUCH_COLUMN_IN_TABLE");
  });

  it("is undefined when the failure did not come from ClickHouse", () => {
    expect(new InsertError("socket hang up").clickhouseErrorType).toBeUndefined();
  });
});

describe("toInsertError", () => {
  it("keeps rejected row text out of everything that gets logged or traced", () => {
    const error = toInsertError(parseError(rawMessage));

    expect(error.message).toBe("ClickHouse insert failed: INCORRECT_DATA");
    expect(error.clickhouseErrorType).toBe("INCORRECT_DATA");
    expect(error.stack).not.toContain("customer-payload");
    expect(String(error)).not.toContain("customer-payload");
    expect(JSON.stringify(error)).not.toContain("customer-payload");
    expect(Object.keys(error)).not.toContain("rawMessage");
  });

  it("keeps the full server text for in-process checks", () => {
    const error = toInsertError(parseError(rawMessage));

    expect(insertErrorServerText(error)).toBe(rawMessage);
  });

  it("keeps transport error messages, which carry no row data", () => {
    const error = toInsertError(new Error("socket hang up"));

    expect(error.message).toBe("socket hang up");
    expect(error.clickhouseErrorType).toBeUndefined();
  });
});

describe("insertErrorServerText", () => {
  it("prefers rawMessage", () => {
    expect(insertErrorServerText(new InsertError("short", { rawMessage: "full text" }))).toBe(
      "full text"
    );
  });

  it("falls back to message", () => {
    expect(insertErrorServerText(new Error("only message"))).toBe("only message");
  });

  it("handles non-objects", () => {
    expect(insertErrorServerText("plain")).toBe("plain");
    expect(insertErrorServerText(undefined)).toBe("");
  });
});

describe("insertErrorType", () => {
  it("reads the ClickHouse type off an insert error", () => {
    expect(insertErrorType(toInsertError(parseError(rawMessage)))).toBe("INCORRECT_DATA");
  });

  it("is undefined for anything else", () => {
    expect(insertErrorType(new Error("socket hang up"))).toBeUndefined();
    expect(insertErrorType("INCORRECT_DATA")).toBeUndefined();
  });
});
