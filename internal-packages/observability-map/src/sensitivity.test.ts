import { classifySensitivity } from "./sensitivity.js";
import { scanFile } from "./scan.js";

const ep = (fileName: string, source: string) => scanFile(fileName, source)!;

describe("classifySensitivity", () => {
  it("flags a route whose filename says nothing but which calls a sensitive helper", () => {
    const e = ep(
      "@.ts",
      `import { clearImpersonation } from "~/models/admin.server";
       export async function loader({ request }) { return clearImpersonation(request, "/admin"); }`
    );
    const s = classifySensitivity(e);
    expect(s.sensitive).toBe(true);
    expect(s.reasons.some((r) => r.includes("clearImpersonation"))).toBe(true);
  });

  it("flags on the path when the filename is explicit", () => {
    const e = ep("api.v1.projects.$ref.envvars.ts", `export async function loader() { return 1; }`);
    expect(classifySensitivity(e).sensitive).toBe(true);
  });

  it("does not flag an ordinary read route", () => {
    const e = ep(
      "api.v1.timezones.ts",
      `import { json } from "@remix-run/server-runtime";
       export async function loader() { return json({ timezones: [] }); }`
    );
    expect(classifySensitivity(e).sensitive).toBe(false);
  });

  it("does not flag on a substring that merely contains a sensitive word", () => {
    const e = ep(
      "api.v1.authorship.ts",
      `export async function loader() { return { author: "x" }; }`
    );
    expect(classifySensitivity(e).sensitive).toBe(false);
  });
});

// Directory routes: `fileName` can be `dirName/route.tsx` rather than a flat dotted name. A naive
// `fileName.split(".")` treats "billing/route" as one non-matching segment because the slash never
// gets split, so it misses the directory name entirely. The classifier must derive real path
// segments (via the same route-path logic the remix adapter uses) so both shapes work alike.
describe("classifySensitivity: directory routes", () => {
  it("flags a single-segment directory route by its directory name", () => {
    const e = ep("billing/route.tsx", `export async function loader() { return 1; }`);
    const s = classifySensitivity(e);
    expect(s.sensitive).toBe(true);
    expect(s.reasons.some((r) => r.includes("billing"))).toBe(true);
  });

  it("flags a multi-segment directory route via a segment among dynamic params", () => {
    const e = ep(
      "_app.orgs.$slug.billing/route.tsx",
      `export async function loader() { return 1; }`
    );
    expect(classifySensitivity(e).sensitive).toBe(true);
  });

  it("does not flag a directory route on a substring that merely contains a sensitive word", () => {
    const e = ep("api.v1.authorship/route.tsx", `export async function loader() { return 1; }`);
    expect(classifySensitivity(e).sensitive).toBe(false);
  });
});

// calleeNames is scoped to the loader/action body, unlike importedNames which is file-wide. A
// sensitive symbol called only at module scope is invisible to calleeNames, so it is only caught
// when it also shows up as an import.
describe("classifySensitivity: calleeNames is body-scoped, importedNames is file-wide", () => {
  it("flags a sensitive symbol invoked only at module scope, via the import rather than the callee", () => {
    const e = ep(
      "api.v1.setup.ts",
      `import { startImpersonation } from "~/models/admin.server";
       startImpersonation(globalThis, "seed");
       export async function loader() { return 1; }`
    );
    const s = classifySensitivity(e);
    expect(s.sensitive).toBe(true);
    expect(s.reasons.some((r) => r.includes("startImpersonation"))).toBe(true);
  });

  it("flags a sensitive callee defined locally and invoked inside the loader, even without an import", () => {
    const e = ep(
      "api.v1.local-admin.ts",
      `async function regenerateApiKey() { return "x"; }
       export async function loader() { return regenerateApiKey(); }`
    );
    expect(classifySensitivity(e).sensitive).toBe(true);
  });

  it("does not flag a sensitive-named call made only at module scope outside the loader/action body", () => {
    const e = ep(
      "api.v1.module-scope.ts",
      `function regenerateApiKey() { return "x"; }
       regenerateApiKey();
       export async function loader() { return 1; }`
    );
    expect(classifySensitivity(e).sensitive).toBe(false);
  });
});

describe("what sensitivity must not mean", () => {
  const ep = (fileName: string, source: string) => scanFile(fileName, source)!;

  // C4. Calling the admin guard cannot be what makes a route risky: it is the mitigation, not the
  // hazard. Counting it made 34 of 67 sensitive entries sensitive only because they were guarded,
  // and `auth-boundary` then passed every one of them on the same call. Circular, and it was the
  // fix list's primary sort key.
  it("does not treat calling the admin guard as what makes a route sensitive", () => {
    const s = classifySensitivity(
      ep(
        "admin.api.v1.queue-metrics.ts",
        `import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
         import { prisma } from "~/db.server";
         export async function loader({ request }) {
           await requireAdminApiRequest(request);
           return json(await prisma.queueMetric.findMany());
         }`
      )
    );
    expect(s.sensitive).toBe(false);
  });

  it("still flags an admin route that does something sensitive on its own account", () => {
    const s = classifySensitivity(
      ep(
        "admin.api.v1.impersonate.ts",
        `import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
         import { startImpersonation } from "~/models/admin.server";
         export async function action({ request }) {
           await requireAdminApiRequest(request);
           return startImpersonation(request, "user_1");
         }`
      )
    );
    expect(s.sensitive).toBe(true);
    expect(s.reasons).toContain("calls startImpersonation");
  });

  // A waitpoint token is a run coordination handle, not a credential. Seven of the eight routes
  // matching the `tokens` segment were waitpoint routes.
  it("does not treat a waitpoint token route as a credential route", () => {
    const s = classifySensitivity(
      ep(
        "api.v1.waitpoints.tokens.$waitpointFriendlyId.complete.ts",
        `import { prisma } from "~/db.server";
         export async function action() { return prisma.waitpoint.update({ where: {}, data: {} }); }`
      )
    );
    expect(s.sensitive).toBe(false);
  });

  it("still flags the personal access token routes", () => {
    expect(
      classifySensitivity(
        ep(
          "account.tokens/route.tsx",
          `import { prisma } from "~/db.server";
           export async function loader() { return prisma.personalAccessToken.findMany(); }`
        )
      ).reasons
    ).toContain('path segment "tokens"');
    expect(
      classifySensitivity(
        ep(
          "api.v1.token.ts",
          `import { prisma } from "~/db.server";
           export async function action() { return prisma.token.create({ data: {} }); }`
        )
      ).reasons
    ).toContain('path segment "token"');
  });
});

// The classifier once covered tokens, billing, impersonation and envvars and missed the entire
// surface where authorization bugs live. The vocabulary is read off `apps/webapp/app/routes`, and
// `webappSymbols.test.ts` holds it to that.
describe("classifySensitivity: the access-control surface", () => {
  const flags = (fileName: string) =>
    classifySensitivity(ep(fileName, `export async function loader() { return 1; }`)).sensitive;

  it.each([
    ["api.v1.orgs.$orgParam.members.ts", "membership"],
    ["api.v1.orgs.$orgParam.invites.ts", "invites"],
    ["invite-accept.tsx", "an invite acceptance"],
    ["_app.orgs.$organizationSlug.settings.roles/route.tsx", "roles"],
    ["orgs.$organizationSlug.team.ts", "the team page"],
    ["login._index/route.tsx", "the login page"],
    ["login.mfa/route.tsx", "the mfa step"],
    ["magic.tsx", "a magic link"],
    ["auth.sso.ts", "sso"],
    ["account.security/route.tsx", "account security"],
    [
      "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route.tsx",
      "api keys",
    ],
    ["admin.api.v1.revoked-api-keys.$id.ts", "revoked api keys"],
    ["_app.orgs.$organizationSlug.settings.billing-limits/route.tsx", "billing limits"],
    ["_app.orgs.$organizationSlug.settings.billing-alerts/route.tsx", "billing alerts"],
    ["admin.api.v1.orgs.$organizationId.billing-limit.hit.ts", "an admin billing limit"],
    ["resources.account.session-duration/route.tsx", "session duration"],
  ])("flags %s (%s)", (fileName) => {
    expect(flags(fileName)).toBe(true);
  });

  // Remix's trailing underscore opts a route out of its parent layout and says nothing about what
  // the route does, so the segment vocabulary is written without it.
  it("flags a route whose segment carries the no-layout marker", () => {
    expect(flags("resources.impersonation_.view-as.ts")).toBe(true);
    expect(flags("resources.impersonation.ts")).toBe(true);
  });

  // Measured and rejected. Every `sessions` route in this tree is the realtime agent-session
  // product, sixteen files of it, and reading the word as the auth session surface would have put
  // all sixteen in front of the routes that mint credentials.
  it("does not flag the agent-session product on the word sessions", () => {
    expect(flags("api.v1.sessions.$session.close.ts")).toBe(false);
    expect(
      flags(
        "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.sessions._index/route.tsx"
      )
    ).toBe(false);
  });

  // Measured and rejected. Logging out destroys the caller's own session: no other party's
  // credential to guard, no actor to record beyond the one already leaving.
  it("does not flag the logout route", () => {
    expect(flags("logout.tsx")).toBe(false);
  });

  it("still does not flag an ordinary route that shares a prefix with the new vocabulary", () => {
    expect(flags("api.v1.teams-directory.ts")).toBe(false);
    expect(flags("resources.logins.ts")).toBe(false);
  });
});
