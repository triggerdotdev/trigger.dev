import { Form } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { env } from "~/env.server";
import {
  clearImpersonation,
  findImpersonationTarget,
  requireImpersonationEnabled,
  startImpersonation,
} from "~/models/admin.server";
import { logger } from "~/services/logger.server";
import { requireUser } from "~/services/session.server";
import {
  impersonationConsentPostBackPath,
  impersonationDestinationPath,
} from "~/utils/pathBuilder";
import { isSameOriginNavigation } from "~/utils/sameOriginNavigation";

// Everything this route's loader and action touch on the server lives in
// `~/models/admin.server` on purpose: Remix only strips `loader`, `action` and
// `headers` from a route module for the browser bundle, so any other export
// here would drag server-only modules into the client build.

export async function loader({ request, params }: LoaderFunctionArgs) {
  requireImpersonationEnabled();

  const user = await requireUser(request);

  // If already impersonating, we need to clear the impersonation. Redirects are
  // thrown, not returned, so the consent page below is the loader's only data
  // shape.
  if (user.isImpersonating) {
    const url = new URL(request.url);
    // Keep the search: `/@/runs/<id>` links redirect here carrying `?span=<spanId>`, and the
    // follow-up GET builds the destination and post-back paths from it. Dropping it would land the
    // admin on the run with no span selected.
    throw await clearImpersonation(request, `${url.pathname}${url.search}`);
  }

  // Only admins can impersonate
  if (!user.admin) {
    throw redirect("/");
  }

  const path = params["*"] ?? "";
  const organizationSlug = params.organizationSlug;

  logger.debug("Impersonating user", { path, organizationSlug });

  if (!organizationSlug) {
    logger.debug("Exiting impersonation mode");
    throw await clearImpersonation(request, "/admin");
  }

  // Starting impersonation is a state change, so it only happens straight away
  // for an unambiguously same-origin navigation — that is what stops a
  // cross-site navigation from silently starting impersonation. Links opened
  // from outside the app (address bar, bookmark, a link shared elsewhere) get
  // the consent page below instead, whose "Impersonate" button posts back from
  // our own page and so satisfies the same check.
  if (isSameOriginNavigation(request, env.LOGIN_ORIGIN)) {
    throw await startImpersonation(request, organizationSlug, path, user);
  }

  // Expected for any link opened outside the app (address bar, bookmark, a link
  // shared elsewhere), so this is routine rather than suspicious. Only the
  // referer's origin is logged — the full referer can carry another site's path
  // and query string.
  logger.info("Impersonation entry outside the app, showing consent page", {
    userId: user.id,
    organizationSlug,
    refererOrigin: refererOrigin(request),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });

  // Read-only on purpose: nothing is written and no impersonation cookie is set
  // until the admin confirms with the POST below.
  const target = await findImpersonationTarget(organizationSlug);

  const search = new URL(request.url).search;

  return typedjson({
    organizationSlug,
    organizationName: target.success ? target.organizationName : undefined,
    destinationPath: impersonationDestinationPath(organizationSlug, path, search),
    postBackPath: impersonationConsentPostBackPath(organizationSlug, path, search),
    canImpersonate: target.success,
  });
}

function refererOrigin(request: Request): string | undefined {
  const referer = request.headers.get("referer");
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  requireImpersonationEnabled();

  if (request.method.toLowerCase() !== "post") {
    return new Response("Method not allowed", { status: 405 });
  }

  const user = await requireUser(request);

  // Same ordering as the loader, and it matters for the same reason: while an
  // impersonation cookie is set `requireUser` resolves to the *impersonated*
  // user, so `user.admin` is false even for a legitimate admin. An admin who
  // started impersonating in another tab and then submitted this page would
  // fail the check below and be bounced to `/` with no explanation. Clear the
  // impersonation first and come back to this same URL under their own
  // identity, where the normal flow re-authorizes them and they can confirm.
  // Never run the impersonation mutation on a request whose resolved identity
  // is the impersonated user.
  if (user.isImpersonating) {
    const url = new URL(request.url);
    // Keep the search for the same reason the loader does: the follow-up GET
    // rebuilds the destination and post-back paths from it.
    return clearImpersonation(request, `${url.pathname}${url.search}`);
  }

  if (!user.admin) {
    return redirect("/");
  }

  // The consent page posts from our own origin, so this holds. Re-applied here
  // so another site cannot drive the POST either.
  if (!isSameOriginNavigation(request, env.LOGIN_ORIGIN)) {
    logger.warn("Refusing cross-site impersonation submission", {
      userId: user.id,
      organizationSlug: params.organizationSlug,
      referer: request.headers.get("referer"),
      secFetchSite: request.headers.get("sec-fetch-site"),
    });
    return redirect("/admin");
  }

  const organizationSlug = params.organizationSlug;

  if (!organizationSlug) {
    return clearImpersonation(request, "/admin");
  }

  // The consent form posts to an explicit absolute path (see
  // `impersonationConsentPostBackPath`), so the organization slug, the splat
  // path and the query string all arrive here intact.
  return startImpersonation(request, organizationSlug, params["*"] ?? "", user);
}

export default function Page() {
  const { organizationSlug, organizationName, destinationPath, postBackPath, canImpersonate } =
    useTypedLoaderData<typeof loader>();

  return (
    <MainCenteredContainer className="max-w-88">
      <div className="flex flex-col gap-4">
        <Header1>Impersonate</Header1>
        {canImpersonate ? (
          <>
            <Paragraph>
              Continue to impersonate a member of{" "}
              <span className="text-text-bright">{organizationName ?? organizationSlug}</span> and
              open <span className="text-text-bright">{destinationPath}</span>.
            </Paragraph>
            <Form method="post" action={postBackPath} reloadDocument>
              <Button type="submit" variant="primary/medium" fullWidth shortcut={{ key: "enter" }}>
                Impersonate
              </Button>
            </Form>
            <Paragraph variant="extra-small">
              Only continue if you meant to open this link. You'll be signed in as a member of this
              organization until you stop impersonating.
            </Paragraph>
          </>
        ) : (
          <Callout variant="error">
            There's no organization <span className="text-text-bright">{organizationSlug}</span>{" "}
            with a member you can impersonate.
          </Callout>
        )}
      </div>
    </MainCenteredContainer>
  );
}
