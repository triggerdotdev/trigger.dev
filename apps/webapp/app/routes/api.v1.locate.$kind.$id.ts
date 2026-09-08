import { json } from "@remix-run/server-runtime";
import invariant from "tiny-invariant";
import { z } from "zod";
import { locateAgentObject } from "~/services/locateAgentObject.server";
import { createLoaderPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const KIND_TO_RESOURCE_TYPE = {
  run: "runs",
  deployment: "deployments",
  error: "errors",
  queue: "queues",
} as const;

// Deployments are addressable only by their globally-unique friendlyId, never `version` (unique
// only per environment) — a bare `deployment_…` shape rejects a version string before any lookup.
// The error id isn't shape-validated here: `locateAgentObject` treats anything `ErrorId.toId`
// can't parse (e.g. `error_a_b`, more than one underscore) as `{ found: false }` rather than
// throwing, so a malformed id 404s like any other nonexistent fingerprint. A queue id is its
// name, bounded only by length — no fixed format.
const ParamsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), id: z.string().regex(/^run_.+$/) }),
  z.object({ kind: z.literal("deployment"), id: z.string().regex(/^deployment_.+$/) }),
  z.object({ kind: z.literal("error"), id: z.string().min(1) }),
  z.object({ kind: z.literal("queue"), id: z.string().min(1).max(200) }),
]);

export const loader = createLoaderPATApiRoute(
  {
    params: ParamsSchema,
    corsStrategy: "all",
    // No org/project/environment is named in the URL, so an org-scoped token is checked against
    // its own organization claim; `locateAgentObject` filters its results the same way.
    organizationScoped: "tokenOrganization",
    authorization: {
      action: "read",
      resource: (params) => ({ type: KIND_TO_RESOURCE_TYPE[params.kind], id: params.id }),
    },
  },
  async ({ params, authentication }) => {
    // `organizationScoped: "tokenOrganization"` already 403s before this runs when the caller
    // carries no organization claim (`assertTokenOrganizationClaim`) — this only narrows the type.
    invariant(authentication.userActor?.organizationId, "Route requires an organization claim");

    const result = await locateAgentObject(params.kind, params.id, {
      userId: authentication.userId,
      organizationId: authentication.userActor.organizationId,
    });

    // A failed warehouse lookup isn't a "not found" — an outage must not look like one at the
    // HTTP level either. A truncated not-found couldn't check everything either, so it's a
    // successful (incomplete) answer, not a 404 — only a complete not-found is.
    const status = result.found || result.truncated ? 200 : result.unavailable ? 503 : 404;
    return json(result, { status });
  }
);
