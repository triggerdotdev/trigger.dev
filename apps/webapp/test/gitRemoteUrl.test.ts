import { describe, expect, it } from "vitest";
import { gitRemoteToHttpsUrl, isHttpUrl } from "~/utils/gitRemoteUrl";

describe("gitRemoteToHttpsUrl", () => {
  it("keeps an https remote and drops the .git suffix", () => {
    expect(gitRemoteToHttpsUrl("https://github.com/acme/app.git")).toBe(
      "https://github.com/acme/app"
    );
  });

  it("upgrades http and removes credentials", () => {
    expect(gitRemoteToHttpsUrl("http://user:token@github.com/acme/app.git")).toBe(
      "https://github.com/acme/app"
    );
  });

  it("rewrites ssh and git remotes to https", () => {
    expect(gitRemoteToHttpsUrl("git://github.com/acme/app.git")).toBe(
      "https://github.com/acme/app"
    );
    expect(gitRemoteToHttpsUrl("git@github.com:acme/app.git")).toBe("https://github.com/acme/app");
    expect(gitRemoteToHttpsUrl("ssh://git@gitlab.example.com:2222/acme/app.git")).toBe(
      "https://gitlab.example.com/acme/app"
    );
  });

  // Catches: a link built for a remote that has no web page.
  it("returns null for other kinds of remote", () => {
    expect(gitRemoteToHttpsUrl("ftp://example.com/acme/app.git")).toBeNull();
    expect(gitRemoteToHttpsUrl("file:///home/dev/app")).toBeNull();
    expect(gitRemoteToHttpsUrl("not a remote")).toBeNull();
    expect(gitRemoteToHttpsUrl("")).toBeNull();
  });
});

describe("isHttpUrl", () => {
  it("accepts only absolute http(s) URLs", () => {
    expect(isHttpUrl("https://github.com/acme/app/tree/main")).toBe(true);
    expect(isHttpUrl("http://github.example.com/acme/app")).toBe(true);
    expect(isHttpUrl("ftp://example.com/acme/app")).toBe(false);
    expect(isHttpUrl("/acme/app")).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
  });
});
