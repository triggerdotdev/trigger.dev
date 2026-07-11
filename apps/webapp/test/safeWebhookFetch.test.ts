import { describe, expect, it } from "vitest";
import {
  assertSafeWebhookUrl,
  UnsafeWebhookUrlError,
} from "../app/v3/services/alerts/safeWebhookFetch.server.js";

// assertSafeWebhookUrl is the per-hop check behind safeWebhookFetch. These
// cases are decided lexically / by IP literal, so no network is needed; the
// DNS-resolution branch and redirect-following are not exercised here.
describe("assertSafeWebhookUrl", () => {
  it("accepts a public http(s) URL given as an IP literal (no DNS needed)", async () => {
    await expect(assertSafeWebhookUrl("https://93.184.216.34/hook")).resolves.toBeInstanceOf(URL);
  });

  it("rejects non-http(s) schemes", async () => {
    for (const url of ["file:///etc/passwd", "gopher://x/_", "javascript:alert(1)", "ftp://h/x"]) {
      await expect(assertSafeWebhookUrl(url)).rejects.toBeInstanceOf(UnsafeWebhookUrlError);
    }
  });

  it("rejects loopback / unspecified / RFC1918 / link-local IPv4 literals", async () => {
    for (const host of [
      "127.0.0.1",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1", // CGNAT 100.64/10
      "100.127.255.255",
    ]) {
      await expect(assertSafeWebhookUrl(`http://${host}/hook`)).rejects.toBeInstanceOf(
        UnsafeWebhookUrlError
      );
    }
  });

  it("rejects multicast and reserved IPv4 ranges", async () => {
    for (const host of ["224.0.0.1", "239.1.1.1", "240.0.0.1"]) {
      await expect(assertSafeWebhookUrl(`http://${host}/hook`)).rejects.toBeInstanceOf(
        UnsafeWebhookUrlError
      );
    }
  });

  it("rejects loopback/internal hostnames before any DNS lookup", async () => {
    for (const host of ["localhost", "svc.internal", "db.local", "0.0.0.0"]) {
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

  it("rejects malformed URLs", async () => {
    await expect(assertSafeWebhookUrl("not a url")).rejects.toBeInstanceOf(UnsafeWebhookUrlError);
  });
});
