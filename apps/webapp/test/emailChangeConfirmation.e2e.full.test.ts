// @vitest-environment jsdom
import { randomBytes } from "node:crypto";
import { generateJWT } from "@trigger.dev/core/v3/jwt";
import { expect, it } from "vitest";
import { getTestServer } from "./helpers/sharedTestServer";
import { seedTestUser } from "./helpers/seedTestSession";

// Must match the webapp test container's SESSION_SECRET.
const SESSION_SECRET = "test-session-secret-for-e2e-tests";
const CONFIRM_PATH = "/account/email/confirm";

async function pendingChange(expirationTime = "1h") {
  const { prisma } = getTestServer();
  const user = await seedTestUser(prisma);
  const email = `new-${randomBytes(6).toString("hex")}@test.local`;
  await prisma.user.update({ where: { id: user.id }, data: { pendingEmail: email } });
  const jwt = await generateJWT({
    secretKey: SESSION_SECRET,
    payload: { kind: "email_change", sub: user.id, email },
    expirationTime,
  });
  return { user, email, token: `tr_ecc_${jwt}` };
}

async function openConfirmation(token: string) {
  const { webapp } = getTestServer();
  const landing = await webapp.fetch(`${CONFIRM_PATH}?token=${encodeURIComponent(token)}`, {
    redirect: "manual",
  });
  expect(landing.status).toBe(302);
  expect(landing.headers.get("location")).toBe(CONFIRM_PATH);
  expect(landing.headers.get("referrer-policy")).toBe("no-referrer");
  const cookie = landing.headers.get("set-cookie")?.split(";")[0] ?? "";
  const page = await webapp.fetch(CONFIRM_PATH, {
    headers: { Cookie: cookie },
    redirect: "manual",
  });
  expect(page.status).toBe(200);
  return { page, cookie };
}

it("redirects off the token URL and confirms only when the rendered form is submitted", async () => {
  const { prisma } = getTestServer();
  const { user, email, token } = await pendingChange();
  const { page, cookie } = await openConfirmation(token);
  const document = new DOMParser().parseFromString(await page.text(), "text/html");
  expect(document.body.textContent).toContain(email);
  const input = document.querySelector<HTMLInputElement>('input[name="token"]');
  const form = input?.form;
  if (!form) throw new Error("No confirmation form rendered");
  expect(form.method).toBe("post");
  const action = new URL(form.getAttribute("action") || page.url, page.url);
  expect(action.search).toBe("");
  expect(await prisma.user.findFirstOrThrow({ where: { id: user.id } })).toMatchObject({
    email: user.email,
    pendingEmail: email,
  });

  const body = new URLSearchParams();
  for (const [name, value] of new FormData(form)) {
    if (typeof value === "string") body.append(name, value);
  }
  const response = await fetch(action, {
    method: form.method,
    headers: { Cookie: cookie },
    body,
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/login");
  expect(await prisma.user.findFirstOrThrow({ where: { id: user.id } })).toMatchObject({
    email,
    pendingEmail: null,
  });
});

it("does not accept a confirmation token from the URL instead of the POST body", async () => {
  const { prisma, webapp } = getTestServer();
  const { user, email, token } = await pendingChange();
  const response = await webapp.fetch(`${CONFIRM_PATH}?token=${encodeURIComponent(token)}`, {
    method: "POST",
    body: new URLSearchParams(),
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  expect(await prisma.user.findFirstOrThrow({ where: { id: user.id } })).toMatchObject({
    email: user.email,
    pendingEmail: email,
  });
});

it("shows an error without a confirmation form for invalid or expired links", async () => {
  const { token } = await pendingChange("-1h");
  for (const invalidToken of ["invalid", token]) {
    const { page } = await openConfirmation(invalidToken);
    const document = new DOMParser().parseFromString(await page.text(), "text/html");
    expect(document.body.textContent).toContain("invalid or has expired");
    expect(document.querySelector('input[name="token"]')).toBeNull();
    expect(document.querySelector('button[type="submit"]')).toBeNull();
  }
});
