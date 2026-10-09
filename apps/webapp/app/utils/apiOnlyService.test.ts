import { describe, expect, it } from "vitest";
import { decideApiOnlyServiceRequest, parseApiOnlyServiceMode } from "./apiOnlyService";
import { getRouterPath } from "./sanitizeHttpUrl";

const APP_ORIGIN = "https://cloud.example";

function decide(method: string, originalUrl: string, appOrigin: string | undefined = APP_ORIGIN) {
  return decideApiOnlyServiceRequest({
    method,
    pathname: getRouterPath({ originalUrl }),
    originalUrl,
    appOrigin,
  });
}

describe("parseApiOnlyServiceMode", () => {
  it("accepts report and enforce", () => {
    expect(parseApiOnlyServiceMode("report")).toBe("report");
    expect(parseApiOnlyServiceMode("enforce")).toBe("enforce");
  });

  it("treats anything else as off", () => {
    expect(parseApiOnlyServiceMode(undefined)).toBeUndefined();
    expect(parseApiOnlyServiceMode("")).toBeUndefined();
    expect(parseApiOnlyServiceMode("true")).toBeUndefined();
  });
});

describe("decideApiOnlyServiceRequest", () => {
  it("allows the machine API paths", () => {
    for (const url of [
      "/api/v1/runs",
      "/api/v3/runs/run_123?include=all",
      "/engine/v1/dev/dequeue",
      "/realtime/v1/runs/run_123",
      "/otel/v1/traces",
      "/webhooks/v1/ingest/op_123",
      "/webhooks/v1/ingest/op_123/w/wt_456",
      "/admin/api/v1/environments/env_123/engine/repair-queues",
      "/healthcheck",
      "/metrics",
    ]) {
      expect(decide("POST", url)).toEqual({ action: "allow" });
    }
  });

  it("allows webhook provider verification GETs on the ingest path", () => {
    expect(decide("GET", "/webhooks/v1/ingest/op_123?challenge=abc")).toEqual({ action: "allow" });
  });

  it("allows the admin API but not the admin dashboard", () => {
    expect(decide("GET", "/admin/api/v1/orgs/org_123/feature-flags")).toEqual({ action: "allow" });
    expect(decide("POST", "/admin/api/v2/orgs/org_123/feature-flags")).toEqual({ action: "allow" });
    expect(decide("GET", "/admin/orgs")).toEqual({
      action: "redirect",
      location: "https://cloud.example/admin/orgs",
    });
    expect(decide("POST", "/admin/apix")).toEqual({ action: "notFound" });
  });

  it("allows the accounts webhook exactly", () => {
    expect(decide("POST", "/webhooks/v1/accounts")).toEqual({ action: "allow" });
    expect(decide("POST", "/webhooks/v1/accounts/")).toEqual({ action: "allow" });
    expect(decide("POST", "/webhooks/v1/accounts/extra")).toEqual({ action: "notFound" });
  });

  it("keeps the rest of /webhooks off API-only services", () => {
    expect(decide("POST", "/webhooks/v1/ingestion")).toEqual({ action: "notFound" });
    expect(decide("POST", "/webhooks/v1/other")).toEqual({ action: "notFound" });
  });

  it("allows the project metrics scrape endpoint but not other project routes", () => {
    expect(decide("GET", "/projects/v3/proj_123/metrics")).toEqual({ action: "allow" });
    expect(decide("GET", "/projects/v3/proj_123/metrics/")).toEqual({ action: "allow" });
    expect(decide("GET", "/projects/v3/proj_123/runs")).toEqual({
      action: "redirect",
      location: "https://cloud.example/projects/v3/proj_123/runs",
    });
    expect(decide("GET", "/projects/v3/proj_123/metrics/extra")).toEqual({
      action: "redirect",
      location: "https://cloud.example/projects/v3/proj_123/metrics/extra",
    });
    expect(decide("GET", "/projects/v3/proj_123")).toEqual({
      action: "redirect",
      location: "https://cloud.example/projects/v3/proj_123",
    });
  });

  it("redirects dashboard GETs to the same path on the app origin", () => {
    expect(decide("GET", "/login")).toEqual({
      action: "redirect",
      location: "https://cloud.example/login",
    });
    expect(decide("HEAD", "/orgs/acme/projects?tab=runs")).toEqual({
      action: "redirect",
      location: "https://cloud.example/orgs/acme/projects?tab=runs",
    });
    expect(decide("GET", "/")).toEqual({ action: "redirect", location: "https://cloud.example/" });
  });

  it("404s other methods on dashboard routes", () => {
    expect(decide("POST", "/login/magic")).toEqual({ action: "notFound" });
    expect(decide("POST", "/resources/timezone")).toEqual({ action: "notFound" });
    expect(decide("DELETE", "/orgs/acme")).toEqual({ action: "notFound" });
  });

  it("allows a trailing slash on machine prefixes, so the server can canonicalize it", () => {
    expect(decide("GET", "/api/v1/runs/")).toEqual({ action: "allow" });
    expect(decide("GET", "/healthcheck/")).toEqual({ action: "allow" });
  });

  it("matches whole path segments, not string prefixes", () => {
    expect(decide("POST", "/apifoo")).toEqual({ action: "notFound" });
    expect(decide("POST", "/metrics-admin")).toEqual({ action: "notFound" });
    expect(decide("POST", "/otelx/v1/traces")).toEqual({ action: "notFound" });
  });

  it("resolves dot segments before matching", () => {
    expect(decide("POST", "/api/../login/magic")).toEqual({ action: "notFound" });
  });

  it("keeps redirects on the app origin for protocol-relative-looking paths", () => {
    expect(decide("GET", "//attacker.example/login")).toEqual({
      action: "redirect",
      location: "https://cloud.example//attacker.example/login",
    });
  });

  it("404s everything outside the machine paths without an app origin", () => {
    const withoutAppOrigin = (originalUrl: string) =>
      decideApiOnlyServiceRequest({
        method: "GET",
        pathname: getRouterPath({ originalUrl }),
        originalUrl,
        appOrigin: undefined,
      });

    expect(withoutAppOrigin("/login")).toEqual({ action: "notFound" });
    expect(withoutAppOrigin("/api/v1/runs")).toEqual({ action: "allow" });
  });
});
