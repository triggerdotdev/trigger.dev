import { describe, expect, it } from "vitest";
import {
  assertAddressAllowed,
  assertSafeWebhookUrl,
  UnsafeWebhookUrlError,
} from "../app/v3/services/alerts/safeWebhookUrl.server.js";

// These cases are decided by the lexical / IP-literal checks, so no network is
// needed. The DNS-resolution branch is not exercised here.
describe("assertSafeWebhookUrl", () => {
  it("accepts a public http(s) URL given as an IP literal (no DNS needed)", async () => {
    await expect(assertSafeWebhookUrl("https://93.184.216.34/hook?x=1")).resolves.toBeInstanceOf(
      URL
    );
  });

  it("rejects non-http(s) schemes", async () => {
    for (const url of [
      "file:///etc/passwd",
      "gopher://evil/_",
      "ftp://host/x",
      "data:text/plain,hi",
      "javascript:alert(1)",
    ]) {
      await expect(assertSafeWebhookUrl(url)).rejects.toBeInstanceOf(UnsafeWebhookUrlError);
    }
  });

  it("rejects loopback and unspecified IPv4", async () => {
    for (const host of ["127.0.0.1", "127.9.9.9", "0.0.0.0"]) {
      await expect(assertSafeWebhookUrl(`http://${host}/hook`)).rejects.toBeInstanceOf(
        UnsafeWebhookUrlError
      );
    }
  });

  it("rejects RFC1918 private ranges", async () => {
    for (const host of ["10.0.0.1", "172.16.0.1", "172.31.255.1", "192.168.1.1"]) {
      await expect(assertSafeWebhookUrl(`http://${host}/hook`)).rejects.toBeInstanceOf(
        UnsafeWebhookUrlError
      );
    }
  });

  it("rejects link-local incl. the cloud metadata address", async () => {
    await expect(
      assertSafeWebhookUrl("http://169.254.169.254/latest/meta-data/")
    ).rejects.toBeInstanceOf(UnsafeWebhookUrlError);
  });

  it("rejects CGNAT, multicast and reserved ranges", async () => {
    for (const host of ["100.64.0.1", "224.0.0.1", "239.1.1.1", "240.0.0.1"]) {
      await expect(assertSafeWebhookUrl(`http://${host}/hook`)).rejects.toBeInstanceOf(
        UnsafeWebhookUrlError
      );
    }
  });

  it("rejects loopback/internal hostnames before any DNS lookup", async () => {
    for (const host of ["localhost", "foo.localhost", "svc.internal", "db.local"]) {
      await expect(assertSafeWebhookUrl(`http://${host}/hook`)).rejects.toBeInstanceOf(
        UnsafeWebhookUrlError
      );
    }
  });

  it("rejects unsafe IPv6 literals", async () => {
    for (const host of ["[::1]", "[fe80::1]", "[fc00::1]", "[::ffff:127.0.0.1]"]) {
      await expect(assertSafeWebhookUrl(`http://${host}/hook`)).rejects.toBeInstanceOf(
        UnsafeWebhookUrlError
      );
    }
  });

  // Regression: bracketed IPv6 literals and Node's hex-normalized IPv4-mapped
  // addresses (::ffff:127.0.0.1 -> ::ffff:7f00:1) must be caught lexically.
  it("rejects bracketed and hex-mapped IPv6 loopback lexically", async () => {
    for (const host of ["[::1]", "[::ffff:7f00:1]"]) {
      await expect(assertSafeWebhookUrl(`http://${host}/hook`)).rejects.toBeInstanceOf(
        UnsafeWebhookUrlError
      );
    }
  });

  it("rejects malformed URLs", async () => {
    await expect(assertSafeWebhookUrl("not a url")).rejects.toBeInstanceOf(UnsafeWebhookUrlError);
  });
});

// assertAddressAllowed is the connect-time check that safeWebhookFetch runs
// inside the socket's DNS lookup. These cases cover its address-range logic.
describe("assertAddressAllowed", () => {
  it("allows public IPv4 / IPv6 addresses", () => {
    expect(() => assertAddressAllowed("93.184.216.34", 4)).not.toThrow();
    expect(() => assertAddressAllowed("2606:2800:220:1:248:1893:25c8:1946", 6)).not.toThrow();
  });

  it("rejects loopback / private / CGNAT / link-local IPv4 (incl. metadata)", () => {
    for (const addr of [
      "127.0.0.1",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
    ]) {
      expect(() => assertAddressAllowed(addr, 4)).toThrow(UnsafeWebhookUrlError);
    }
  });

  it("rejects loopback / ULA / link-local / mapped IPv6", () => {
    for (const addr of ["::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1"]) {
      expect(() => assertAddressAllowed(addr, 6)).toThrow(UnsafeWebhookUrlError);
    }
  });
});
