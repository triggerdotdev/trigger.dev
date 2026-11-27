import { describe, expect, it } from "vitest";
import { MAX_PREFILL_PAYLOAD_BYTES, testPayloadPrefill } from "./testPayloadPrefill.server";

const link = (payload: string) =>
  new URL(`https://cloud.trigger.dev/test?payload=${encodeURIComponent(payload)}`);
const encode = (text: string) => Buffer.from(text, "utf8").toString("base64url");

describe("testPayloadPrefill", () => {
  it("decodes a base64url JSON payload and pretty-prints it", () => {
    expect(testPayloadPrefill(link(encode('{"message":"héllo ✓","n":1}')))).toBe(
      '{\n  "message": "héllo ✓",\n  "n": 1\n}'
    );
  });

  it("ignores a missing or empty param", () => {
    expect(testPayloadPrefill(new URL("https://cloud.trigger.dev/test"))).toBeUndefined();
    expect(testPayloadPrefill(link(""))).toBeUndefined();
  });

  it("accepts a payload at the limit and ignores one past it", () => {
    const fits = JSON.stringify("x".repeat(MAX_PREFILL_PAYLOAD_BYTES - 2));
    expect(testPayloadPrefill(link(encode(fits)))).toBe(fits);
    expect(
      testPayloadPrefill(link(encode(JSON.stringify("x".repeat(MAX_PREFILL_PAYLOAD_BYTES)))))
    ).toBeUndefined();
  });

  it("ignores values that aren't base64url, UTF-8 or JSON", () => {
    expect(testPayloadPrefill(link("eyJh+IjoxfQ=="))).toBeUndefined();
    expect(
      testPayloadPrefill(link(Buffer.from([0x22, 0xff, 0x22]).toString("base64url")))
    ).toBeUndefined();
    expect(testPayloadPrefill(link(encode("{ message: 'not json' }")))).toBeUndefined();
  });
});
