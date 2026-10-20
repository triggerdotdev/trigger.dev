import { beforeEach, describe, expect, it, vi } from "vitest";

const STATE = vi.hoisted(() => ({
  integration: null as object | null,
  authRedirectTo: undefined as string | undefined,
  successTo: undefined as string | undefined,
}));

vi.mock("~/db.server", () => ({
  prisma: { organizationIntegration: { findFirst: async () => STATE.integration } },
}));
vi.mock("~/models/message.server", () => ({
  redirectWithSuccessMessage: async (to: string) => {
    STATE.successTo = to;
    return new Response();
  },
}));
vi.mock("~/models/orgIntegration.server", () => ({
  OrgIntegrationRepository: {
    redirectToAuthService: async (_s: string, _o: string, _u: string, _r: Request, to: string) => {
      STATE.authRedirectTo = to;
      return new Response();
    },
  },
}));
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: async () => ({ id: "p1", organizationId: "o1", slug: "proj" }),
}));
vi.mock("~/services/session.server", () => ({ requireUserId: async () => "u1" }));
vi.mock("~/services/logger.server", () => ({ logger: { error: () => {} } }));

import { loader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts.new.connect-to-slack";

const params = { organizationSlug: "org", projectParam: "proj", envParam: "prod" };
const call = (qs: string) =>
  loader({
    request: new Request(`http://localhost/connect${qs}`),
    params,
    context: {},
  } as never);

describe("connect-to-slack returnTo", () => {
  beforeEach(() => {
    STATE.integration = null;
    STATE.authRedirectTo = undefined;
    STATE.successTo = undefined;
  });

  it("carries a same-origin returnTo through the OAuth redirect", async () => {
    await call(`?returnTo=${encodeURIComponent("/x?add=slack")}`);
    expect(STATE.authRedirectTo).toMatch(/\/new\/connect-to-slack\?returnTo=%2Fx%3Fadd%3Dslack$/);
  });

  it("redirects to returnTo when the integration exists", async () => {
    STATE.integration = { id: "i1" };
    await call("?returnTo=%2Fx");
    expect(STATE.successTo).toBe("/x");
  });

  it.each(["https://evil.com", "//evil.com", "/\\evil.com"])("ignores %s", async (bad) => {
    STATE.integration = { id: "i1" };
    await call(`?returnTo=${encodeURIComponent(bad)}`);
    expect(STATE.successTo).toContain("?option=slack");
    STATE.integration = null;
    await call(`?returnTo=${encodeURIComponent(bad)}`);
    expect(STATE.authRedirectTo).not.toContain("returnTo");
  });

  it("keeps the legacy page without returnTo", async () => {
    STATE.integration = { id: "i1" };
    await call("");
    expect(STATE.successTo).toContain("?option=slack");
  });
});
