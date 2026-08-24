import { matchRoutes, resolveTo } from "@remix-run/router";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { impersonationConsentPostBackPath, impersonationDestinationPath } from "./pathBuilder";

// The route that renders the impersonation consent page, as the flat-route
// convention compiles `_app.@.orgs.$organizationSlug.$.tsx`.
const CONSENT_ROUTES = [
  {
    id: "routes/_app",
    children: [
      {
        id: "routes/_app.@.orgs.$organizationSlug.$",
        path: "@/orgs/:organizationSlug/*",
      },
    ],
  },
];

/**
 * What the consent route's `action` would receive for a POST to `pathname`:
 * the organization slug and the splat, straight off the router.
 */
function actionParamsFor(pathname: string) {
  const matches = matchRoutes(CONSENT_ROUTES, pathname);
  const leaf = matches?.[matches.length - 1];
  return {
    organizationSlug: leaf?.params.organizationSlug,
    splat: leaf?.params["*"],
  };
}

/**
 * What `<Form method="post">` with NO `action` prop resolves to, reproducing
 * `useFormAction()`: `resolveTo(".", …)` over the matched routes' contributing
 * pathnames. This app does not enable `future.v3_relativeSplatPath`, so each
 * contributing match supplies its `pathnameBase`.
 */
function relativeFormAction(pathname: string) {
  const matches = matchRoutes(CONSENT_ROUTES, pathname) ?? [];
  const contributing = matches.filter((m, i) => i === 0 || Boolean(m.route.path));
  const routePathnames = contributing.map((m) => m.pathnameBase);
  return resolveTo(".", routePathnames, pathname, false).pathname;
}

describe("impersonation consent post-back path", () => {
  const slug = "acme-inc";
  // A `/@/runs/<id>` link redirects here: a deep run path plus the `?span=`
  // that selects which span to open.
  const splat = "projects/proj_123/env/prod/runs/run_abc";
  const search = "?span=span_xyz";

  it("keeps the splat and the query string", () => {
    expect(impersonationConsentPostBackPath(slug, splat, search)).toBe(
      `/@/orgs/${slug}/${splat}${search}`
    );
    expect(impersonationDestinationPath(slug, splat, search)).toBe(
      `/orgs/${slug}/${splat}${search}`
    );
  });

  it("omits the query string when there isn't one", () => {
    expect(impersonationConsentPostBackPath(slug, splat)).toBe(`/@/orgs/${slug}/${splat}`);
    expect(impersonationDestinationPath(slug, splat)).toBe(`/orgs/${slug}/${splat}`);
  });

  it("round-trips the slug and splat back to the action", () => {
    const postBackPath = impersonationConsentPostBackPath(slug, splat, search);

    expect(actionParamsFor(new URL(postBackPath, "http://localhost").pathname)).toEqual({
      organizationSlug: slug,
      splat,
    });
  });

  it("the destination the action redirects to matches the one the page displayed", () => {
    const postBackPath = impersonationConsentPostBackPath(slug, splat, search);
    const url = new URL(postBackPath, "http://localhost");
    const params = actionParamsFor(url.pathname);

    // What `startImpersonation` builds from the action's params + request URL.
    expect(impersonationDestinationPath(params.organizationSlug!, params.splat!, url.search)).toBe(
      impersonationDestinationPath(slug, splat, search)
    );
  });

  // The regression this file exists for. A relative `<Form>` action drops the
  // splat, so the action would start impersonation and land the admin on the
  // organization root rather than the deep link the consent page promised.
  it("a relative form action would drop the splat, so the path must be explicit", () => {
    const consentUrl = `/@/orgs/${slug}/${splat}`;

    expect(relativeFormAction(consentUrl)).toBe(`/@/orgs/${slug}`);
    expect(actionParamsFor(relativeFormAction(consentUrl))).toEqual({
      organizationSlug: slug,
      splat: "",
    });

    // The explicit path does not.
    expect(impersonationConsentPostBackPath(slug, splat)).toBe(consentUrl);
  });

  // Ideally this would render the route and read the emitted `action`
  // attribute, but the route module imports `~/env.server`, which validates the
  // full server environment at import time and so cannot be pulled into a unit
  // test. Asserting on the source is the next best guard: it fails if the
  // `action` prop is ever dropped, which is the whole bug.
  it("the consent form names its action explicitly", () => {
    const source = readFileSync(
      join(__dirname, "../routes/_app.@.orgs.$organizationSlug.$.tsx"),
      "utf8"
    );

    const form = source.match(/<Form\b[^>]*>/);
    expect(form).not.toBeNull();
    expect(form![0]).toMatch(/action=\{postBackPath\}/);
  });
});
