import { describe, expect, it } from "vitest";
import { missingJwtLogContext } from "../app/services/safeRequestLogContext.js";

const reqWith = (headers: Record<string, string>) =>
  new Request("https://api.trigger.dev/api/v1/runs?x=1", { method: "POST", headers });

// The breadcrumb must never carry header values, only presence.
describe("missingJwtLogContext", () => {
  it("returns only method, path, and a hasAuthorization boolean", () => {
    const ctx = missingJwtLogContext(reqWith({ authorization: "Bearer tr_secret_key" }));
    expect(ctx).toEqual({ method: "POST", path: "/api/v1/runs", hasAuthorization: true });
  });

  it("never includes the Authorization value or a raw headers map (the leak)", () => {
    const ctx = missingJwtLogContext(
      reqWith({ authorization: "Bearer tr_secret_key", cookie: "__session=abc" })
    );
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain("tr_secret_key");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("__session");
    // hasAuthorization signals presence without leaking the value.
    expect(ctx.hasAuthorization).toBe(true);
  });

  it("reports hasAuthorization=false when the header is absent", () => {
    expect(missingJwtLogContext(reqWith({})).hasAuthorization).toBe(false);
  });
});
