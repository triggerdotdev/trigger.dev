import { Form } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { $replica, prisma, type PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { clearImpersonation, redirectWithImpersonation } from "~/models/admin.server";
import { logger } from "~/services/logger.server";
import { requireUser } from "~/services/session.server";
import { isSameOriginNavigation } from "~/utils/sameOriginNavigation";

type ImpersonationTarget =
  | { success: true; userId: string; organizationName: string }
  | { success: false; reason: "org-not-found" | "no-confirmed-member" };

/**
 * Read-only lookup of who a `/@/orgs/<slug>/…` link would impersonate: the
 * first organization member who has confirmed their basic details. Writes
 * nothing, so it is safe to call while only rendering the consent page.
 */
export async function findImpersonationTarget(
  organizationSlug: string,
  prismaClient: PrismaClientOrTransaction = $replica
): Promise<ImpersonationTarget> {
  const org = await prismaClient.organization.findFirst({
    where: {
      slug: organizationSlug,
      deletedAt: null,
    },
    select: {
      title: true,
      members: {
        select: {
          user: {
            select: {
              id: true,
              confirmedBasicDetails: true,
            },
          },
        },
      },
    },
  });

  if (!org) {
    return { success: false, reason: "org-not-found" };
  }

  const firstValidMember = org.members.find((m) => m.user.confirmedBasicDetails);

  if (!firstValidMember) {
    return { success: false, reason: "no-confirmed-member" };
  }

  return { success: true, userId: firstValidMember.user.id, organizationName: org.title };
}

/**
 * Starts impersonating the organization's first confirmed member and lands on
 * the requested path with the `/@` prefix stripped. Shared by the same-origin
 * loader path and the consent page's POST so there is one implementation.
 */
export async function startImpersonation(
  request: Request,
  organizationSlug: string,
  path: string,
  currentUser: { id: string; admin: boolean },
  clients: { read: PrismaClientOrTransaction; write: PrismaClientOrTransaction } = {
    read: $replica,
    write: prisma,
  }
) {
  const target = await findImpersonationTarget(organizationSlug, clients.read);

  if (!target.success) {
    logger.debug("Cannot impersonate organization", { organizationSlug, reason: target.reason });
    return clearImpersonation(request, "/admin");
  }

  return redirectWithImpersonation(
    request,
    target.userId,
    `/orgs/${organizationSlug}/${path}`,
    currentUser,
    clients.write
  );
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireUser(request);

  // If already impersonating, we need to clear the impersonation. Redirects are
  // thrown, not returned, so the consent page below is the loader's only data
  // shape.
  if (user.isImpersonating) {
    const url = new URL(request.url);
    throw await clearImpersonation(request, url.pathname);
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

  logger.warn("Cross-site impersonation entry, showing consent page", {
    userId: user.id,
    organizationSlug,
    referer: request.headers.get("referer"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });

  // Read-only on purpose: nothing is written and no impersonation cookie is set
  // until the admin confirms with the POST below.
  const target = await findImpersonationTarget(organizationSlug);

  return typedjson({
    organizationSlug,
    organizationName: target.success ? target.organizationName : undefined,
    destinationPath: `/orgs/${organizationSlug}/${path}`,
    canImpersonate: target.success,
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toLowerCase() !== "post") {
    return new Response("Method not allowed", { status: 405 });
  }

  const user = await requireUser(request);

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

  // The form has no `action`, so it posts to the current URL and the
  // organization slug plus the splat path arrive here unchanged.
  return startImpersonation(request, organizationSlug, params["*"] ?? "", user);
}

export default function Page() {
  const { organizationSlug, organizationName, destinationPath, canImpersonate } =
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
            <Form method="post" reloadDocument>
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
