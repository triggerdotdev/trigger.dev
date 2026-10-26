import { describe, expect, it } from "vitest";
import { createAdminOriginResolver } from "../app/utils/adminOrigin";

describe("temporary admin origin", () => {
  it("selects only the configured host, including behind an HTTP proxy", () => {
    const resolve = createAdminOriginResolver("https://admin.example");
    const request = (host: string) =>
      new Request("http://backend.internal/login", {
        headers: { Host: host, "X-Forwarded-Host": "admin.example" },
      });
    expect(resolve(request("ADMIN.EXAMPLE:443"))).toBe("https://admin.example");
    expect(resolve(request("admin.localhost:5400"))).toBeUndefined();
    expect(resolve(request("attacker.example"))).toBeUndefined();
    expect(resolve(request("admin.example:444"))).toBeUndefined();
    expect(createAdminOriginResolver()(request("admin.example"))).toBeUndefined();
  });

  it.each([
    "http://admin.example",
    "https://admin.example/login",
    "https://admin.example,https://other.example",
    "https://user:password@admin.example",
  ])("rejects an invalid admin origin: %s", (value) => {
    expect(() => createAdminOriginResolver(value)).toThrow();
  });
});
