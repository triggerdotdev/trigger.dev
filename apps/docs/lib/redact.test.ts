import { describe, expect, it } from "vitest";
import { redact } from "./redact";

describe("redact", () => {
  // Catches: a reader's pasted key or email reaching analytics and the content-gap issues.
  it("redacts keys, tokens and emails", () => {
    expect(redact("why does tr_dev_abc123XYZ fail")).toBe("why does [key] fail");
    expect(redact("tr_prod_sk_9f8e7d and tr_pat_0123456789abcdef")).toBe("[key] and [key]");
    expect(redact("I'm jane.doe+docs@example.co.uk")).toBe("I'm [email]");
    expect(redact("sk-ant-api03-abcdefghijklmnopqrst")).toBe("[token]");
    expect(redact("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("[token]");
    expect(redact("token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_part")).toBe("token [token]");
    expect(redact("hash 3f2a9c0b7e6d5a4b3c2d1e0f9a8b7c6d5e4f3a2b")).toBe("hash [token]");
  });

  it("leaves ordinary questions alone", () => {
    for (const text of [
      "how do retries work?",
      "triggerAndWait with idempotencyKey",
      "/docs/guides/frameworks/nextjs-webhooks-and-server-actions",
      "machine large-2x",
      "run_cm1a2b3c4d5e6f7g8h9i0j",
    ])
      expect(redact(text)).toBe(text);
  });
});
