import { describe, expect, it } from "vitest";
import { triggerConcurrencyKeyBody } from "./concurrencyKey.js";

describe("triggerConcurrencyKeyBody", () => {
  // Catches: a missing value coerced into the key "undefined" or "null", or an entry silently dropped.
  it("rejects an object whose default or entry has no usable key", () => {
    const body = (key: unknown) => () => triggerConcurrencyKeyBody(key as Record<string, string>);

    expect(body({ default: undefined, org: "o" })).toThrow("needs a `default` key");
    expect(body({ default: "", org: "o" })).toThrow("needs a `default` key");
    expect(body({ default: "s", org: null })).toThrow('entry "org"');
    expect(body({ default: "s", org: "" })).toThrow('entry "org"');
    expect(body({ default: "s", org: Number.NaN })).toThrow('entry "org"');
    expect(body({ default: "s", org: Number.POSITIVE_INFINITY })).toThrow('entry "org"');
    expect(
      body(
        new (class {
          default = "s";
          org = undefined;
        })()
      )
    ).toThrow('entry "org"');
    expect(body(JSON.parse('{"default":"s","__proto__":"o"}'))).toThrow('entry "__proto__"');
  });

  // Catches: a plain key no longer sent exactly as given, and numbers not sent as strings.
  it("sends a plain key as given and an object with string values", () => {
    expect(triggerConcurrencyKeyBody("s")).toEqual({ concurrencyKey: "s" });
    expect(triggerConcurrencyKeyBody(null as unknown as undefined)).toEqual({
      concurrencyKey: null,
    });
    expect(
      triggerConcurrencyKeyBody({ default: 7, org: 5 } as unknown as Record<string, string>)
    ).toEqual({ concurrencyKey: { default: "7", org: "5" } });
  });

  // Catches: a value that serialises to a single string key being treated as a key map.
  it("sends a date and an object with toJSON as given", () => {
    const send = (key: unknown) =>
      JSON.stringify(triggerConcurrencyKeyBody(key as Record<string, string>));

    expect(send(new Date(0))).toBe('{"concurrencyKey":"1970-01-01T00:00:00.000Z"}');
    expect(send({ toJSON: () => "id-1" })).toBe('{"concurrencyKey":"id-1"}');
  });
});
