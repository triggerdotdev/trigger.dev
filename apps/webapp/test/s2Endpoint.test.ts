import { describe, expect, it } from "vitest";
import { isValidS2Endpoint } from "~/utils/s2Endpoint";

describe("isValidS2Endpoint", () => {
  it("accepts https anywhere", () => {
    expect(isValidS2Endpoint("https://a.s2.dev")).toBe(true);
    expect(isValidS2Endpoint("https://s2.internal:4566/v1")).toBe(true);
  });

  it("accepts http to a loopback host", () => {
    expect(isValidS2Endpoint("http://localhost:4566")).toBe(true);
    expect(isValidS2Endpoint("http://127.0.0.1:4566")).toBe(true);
    expect(isValidS2Endpoint("http://[::1]:4566")).toBe(true);
  });

  // This is how the self-hosted stack reaches S2, so rejecting it would force TLS on a private
  // container network.
  it("accepts http to a container or service name and a private address", () => {
    expect(isValidS2Endpoint("http://s2/v1")).toBe(true);
    expect(isValidS2Endpoint("http://s2:80/v1")).toBe(true);
    expect(isValidS2Endpoint("http://10.0.0.5:4566")).toBe(true);
    expect(isValidS2Endpoint("http://172.20.0.3")).toBe(true);
    expect(isValidS2Endpoint("http://192.168.1.9")).toBe(true);
  });

  // The access token is sent to whatever is configured, so cleartext to a routable host leaks it.
  it("rejects http to a public host", () => {
    expect(isValidS2Endpoint("http://s2.example.com")).toBe(false);
    expect(isValidS2Endpoint("http://a.s2.dev")).toBe(false);
    expect(isValidS2Endpoint("http://8.8.8.8")).toBe(false);
    expect(isValidS2Endpoint("http://172.32.0.1")).toBe(false);
  });

  // All four pass zod's `.url()`, which is why the schema refines on this instead.
  it("rejects malformed and non-http schemes", () => {
    expect(isValidS2Endpoint("htp:/localhost:4566")).toBe(false);
    expect(isValidS2Endpoint("ftp://localhost")).toBe(false);
    expect(isValidS2Endpoint("not a url")).toBe(false);
    expect(isValidS2Endpoint("")).toBe(false);
  });
});
