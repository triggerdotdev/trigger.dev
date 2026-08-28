import { describe, expect, it } from "vitest";
import { buildPrismaConnectionUrl } from "./prismaConnectionUrl";

describe("buildPrismaConnectionUrl", () => {
  it("sets connect_timeout (the Postgres connector parameter), not the ignored connection_timeout", () => {
    const url = buildPrismaConnectionUrl("postgresql://u:p@host:5432/db?schema=public", {
      connectionLimit: "10",
      poolTimeout: "0",
      connectTimeout: "20",
      applicationName: "svc",
    });

    expect(url.searchParams.get("connect_timeout")).toBe("20");
    expect(url.searchParams.has("connection_timeout")).toBe(false);
    expect(url.searchParams.get("connection_limit")).toBe("10");
    expect(url.searchParams.get("pool_timeout")).toBe("0");
    expect(url.searchParams.get("application_name")).toBe("svc");
  });

  it("preserves existing base query params", () => {
    const url = buildPrismaConnectionUrl(
      "postgresql://u:p@host:5432/db?schema=public&sslmode=require",
      { connectionLimit: "5", poolTimeout: "10", connectTimeout: "20", applicationName: "svc" }
    );

    expect(url.searchParams.get("schema")).toBe("public");
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.searchParams.get("connect_timeout")).toBe("20");
  });
});
