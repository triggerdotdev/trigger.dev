import { createCookieSessionStorage } from "@remix-run/node";
import { EmailLinkStrategy } from "remix-auth-email-link";
import { describe, expect, it } from "vitest";
import { pinMagicLinkOrigin } from "./magicLinkOrigin.server";

const LOGIN_ORIGIN = "https://cloud.example";

function createStrategy() {
  const sentLinks: string[] = [];
  const strategy = new EmailLinkStrategy<{ id: string }>(
    {
      secret: "test-magic-link-secret",
      callbackURL: "/magic",
      sendEmail: async ({ magicLink }) => {
        sentLinks.push(magicLink);
      },
    },
    async () => ({ id: "user" })
  );
  return { strategy, sentLinks };
}

async function requestLink(strategy: EmailLinkStrategy<{ id: string }>, headers: HeadersInit) {
  const sessionStorage = createCookieSessionStorage({
    cookie: { name: "__session", secrets: ["test-session-secret"] },
  });
  const request = new Request("https://cloud.example/login/magic", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ email: "someone@example.com" }),
  });

  const thrown = await strategy
    .authenticate(request, sessionStorage, {
      name: "email-link",
      sessionKey: "user",
      sessionErrorKey: "auth:error",
      sessionStrategyKey: "strategy",
      successRedirect: "/login/magic",
      failureRedirect: "/login",
    })
    .catch((error: unknown) => error);

  expect(thrown).toBeInstanceOf(Response);
  expect((thrown as Response).headers.get("Location")).toBe("/login/magic");
}

describe("pinMagicLinkOrigin", () => {
  it("builds the link from the request's forwarded host without it", async () => {
    const { strategy, sentLinks } = createStrategy();

    await requestLink(strategy, { Host: "cloud.example", "X-Forwarded-Host": "attacker.example" });

    expect(new URL(sentLinks[0]).host).toBe("attacker.example");
  });

  it("ignores a forged X-Forwarded-Host", async () => {
    const { strategy, sentLinks } = createStrategy();
    pinMagicLinkOrigin(strategy, LOGIN_ORIGIN);

    await requestLink(strategy, {
      Host: "cloud.example",
      "X-Forwarded-Host": "attacker.example",
      "X-Forwarded-Proto": "http",
    });

    expect(sentLinks).toHaveLength(1);
    expect(sentLinks[0].startsWith(`${LOGIN_ORIGIN}/magic?token=`)).toBe(true);
  });

  it("ignores a forged Host", async () => {
    const { strategy, sentLinks } = createStrategy();
    pinMagicLinkOrigin(strategy, LOGIN_ORIGIN);

    await requestLink(strategy, { Host: "attacker.example" });

    expect(sentLinks[0].startsWith(`${LOGIN_ORIGIN}/magic?token=`)).toBe(true);
  });

  it("normalizes an origin given with a trailing slash or path", async () => {
    const { strategy, sentLinks } = createStrategy();
    pinMagicLinkOrigin(strategy, "https://cloud.example/some/path/");

    await requestLink(strategy, { Host: "cloud.example" });

    expect(sentLinks[0].startsWith("https://cloud.example/magic?token=")).toBe(true);
  });

  it("throws when the strategy no longer has getDomainURL", () => {
    expect(() => pinMagicLinkOrigin({}, LOGIN_ORIGIN)).toThrow(/getDomainURL/);
  });
});
