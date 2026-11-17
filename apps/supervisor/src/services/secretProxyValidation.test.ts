import { describe, expect, it } from "vitest";
import { isSecretProxyHostname } from "./secretProxyBindings.js";

describe("secret proxy hostnames", () => {
  // Catches: valid consecutive hyphens and punycode rejected during binding attachment.
  it("accepts canonical DNS labels through the hostname length limit", () => {
    for (const host of [
      "api.example.com",
      "a--b.example.com",
      "xn--bcher-kva.example",
      ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join("."),
    ]) {
      expect(isSecretProxyHostname(host), host).toBe(true);
    }
  });

  // Catches: accepting noncanonical destinations or oversized DNS names in node bindings.
  it("rejects IPs, noncanonical authorities, and oversized labels or hostnames", () => {
    for (const host of [
      "",
      "localhost",
      "API.example.com",
      "api.example.com.",
      "api..example.com",
      "-api.example.com",
      "api-.example.com",
      "api_name.example.com",
      "*.example.com",
      "api.example.com:443",
      "api.example.com:8443",
      "https://api.example.com",
      "127.0.0.1",
      "[::1]",
      `${"a".repeat(64)}.example.com`,
      ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(62)].join("."),
    ]) {
      expect(isSecretProxyHostname(host), host).toBe(false);
    }
  });
});
