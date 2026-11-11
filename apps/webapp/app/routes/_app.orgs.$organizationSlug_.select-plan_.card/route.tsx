import { CreditCardIcon } from "@heroicons/react/20/solid";
import { Form, useNavigation } from "@remix-run/react";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { BackgroundWrapper } from "~/components/BackgroundWrapper";
import {
  FREE_CARD_RETURN_TO_PARAM,
  parseFreeCardReturnTo,
} from "~/components/billing/freeCardStepPath";
import { AppContainer, PageBody } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { featuresForRequest } from "~/features.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { resolveOrgIdFromSlug } from "~/models/organization.server";
import { freeCardReturnCookie } from "~/services/freeCardReturnCookie.server";
import { freeCardDonePath, freeCardStepPath, needsCardStep } from "~/services/freeCardStep.server";
import { prisma } from "~/db.server";
import { startFreeCardCheckout } from "~/services/platform.v3.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { pageMeta } from "~/utils/pageTitle";
import { newProjectPath, OrganizationParamsSchema, organizationPath } from "~/utils/pathBuilder";

export const meta = pageMeta("Verify your card");

const routeOptions = {
  params: OrganizationParamsSchema,
  context: async (params: z.infer<typeof OrganizationParamsSchema>) => {
    const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
    return organizationId ? { organizationId } : {};
  },
  authorization: { action: "manage", resource: { type: "billing" } },
} as const;

export const loader = dashboardLoader(
  { ...routeOptions, unauthorizedRedirect: "/" },
  async ({ params, request }) => {
    const organization = { slug: params.organizationSlug };
    if (!featuresForRequest(request).isManagedCloud) {
      return redirect(organizationPath(organization));
    }

    const org = await prisma.organization.findFirst({
      where: { slug: params.organizationSlug },
      select: { id: true, createdAt: true },
    });
    if (!org) {
      throw new Response(null, { status: 404, statusText: "Organization not found" });
    }
    const returnTo = parseFreeCardReturnTo(
      new URL(request.url).searchParams.get(FREE_CARD_RETURN_TO_PARAM)
    );
    if (!(await needsCardStep(org))) {
      return redirect(freeCardDonePath(organization, returnTo));
    }

    return typedjson({ organizationSlug: params.organizationSlug, returnTo });
  }
);

const FormSchema = z.object({
  intent: z.enum(["add-card", "skip"]),
  [FREE_CARD_RETURN_TO_PARAM]: z.string().optional(),
});

export const action = dashboardAction(routeOptions, async ({ params, request }) => {
  const organization = { slug: params.organizationSlug };
  const form = FormSchema.parse(Object.fromEntries(await request.formData()));
  const returnTo = parseFreeCardReturnTo(form[FREE_CARD_RETURN_TO_PARAM]);
  if (form.intent === "skip") {
    return redirect(
      returnTo
        ? freeCardDonePath(organization, returnTo)
        : newProjectPath(
            organization,
            "You're on the Free plan. Verify your card any time to deploy to the cloud."
          )
    );
  }

  const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
  if (!organizationId) {
    throw new Response(null, { status: 404, statusText: "Organization not found" });
  }

  const checkout = await startFreeCardCheckout(organizationId);
  if (!checkout.success) {
    return redirectWithErrorMessage(
      freeCardStepPath(organization, returnTo),
      request,
      "We couldn't open the card page. Please try again."
    );
  }
  // Always written, so a target left over from an abandoned attempt can't redirect this one.
  return redirect(checkout.checkoutUrl, {
    headers: {
      "Set-Cookie": await (returnTo
        ? freeCardReturnCookie.serialize(returnTo)
        : freeCardReturnCookie.serialize("", { maxAge: 0 })),
    },
  });
});

export default function FreeCardStepPage() {
  const { returnTo } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submitting = navigation.formData?.get("intent");

  return (
    <AppContainer>
      <PageBody className="bg-background-deep">
        <BackgroundWrapper>
          <div className="mx-auto mt-4 flex h-fit min-h-full w-full max-w-xl flex-col items-center justify-center gap-8 lg:mt-0">
            <Header1 className="text-center">Unlock your $5/month Free tier credits</Header1>
            <div className="w-full rounded-lg border border-grid-bright bg-background-dimmed p-5 shadow-lg">
              <div className="flex w-full flex-col gap-6 border border-grid-dimmed p-6">
                <div className="flex flex-col gap-2">
                  <h2 className="text-xl font-medium text-text-dimmed">Free</h2>
                  <h3 className="text-4xl font-medium tabular-nums text-text-bright">
                    $0
                    <span className="ml-1 text-sm font-normal tracking-wide text-text-dimmed">
                      /month
                    </span>
                  </h3>
                </div>
                <div className="flex flex-col gap-2">
                  <Header2>Verify your card to unlock your Free tier credits</Header2>
                  <Paragraph variant="small">
                    It’s a verification check only, so you won’t be charged. The Free tier includes
                    $5 of compute each month, and we won’t charge you if you go over. Your bank may
                    show a temporary $1 hold that’s auto-released.
                  </Paragraph>
                </div>
                <div className="flex flex-col gap-3">
                  <Form method="post">
                    <input type="hidden" name="intent" value="add-card" />
                    <ReturnToInput returnTo={returnTo} />
                    <Button
                      type="submit"
                      variant="primary/large"
                      fullWidth
                      LeadingIcon={CreditCardIcon}
                      disabled={submitting !== undefined}
                    >
                      {submitting === "add-card" ? "Opening…" : "Verify card"}
                    </Button>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="intent" value="skip" />
                    <ReturnToInput returnTo={returnTo} />
                    <Button
                      type="submit"
                      variant="secondary/large"
                      fullWidth
                      disabled={submitting !== undefined}
                    >
                      Skip
                    </Button>
                  </Form>
                  <Paragraph variant="extra-small" className="text-center">
                    You can work in the Dev environment without a card, and just add one later.
                  </Paragraph>
                </div>
              </div>
            </div>
          </div>
        </BackgroundWrapper>
      </PageBody>
    </AppContainer>
  );
}

function ReturnToInput({ returnTo }: { returnTo?: string }) {
  return returnTo ? (
    <input type="hidden" name={FREE_CARD_RETURN_TO_PARAM} value={returnTo} />
  ) : null;
}
