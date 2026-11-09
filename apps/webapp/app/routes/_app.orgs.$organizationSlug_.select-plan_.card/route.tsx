import { CheckCircleIcon, CreditCardIcon, LockClosedIcon } from "@heroicons/react/20/solid";
import { Form, useNavigation } from "@remix-run/react";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { BackgroundWrapper } from "~/components/BackgroundWrapper";
import { AppContainer, PageBody } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Header1, Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { featuresForRequest } from "~/features.server";
import { redirectWithErrorMessage } from "~/models/message.server";
import { resolveOrgIdFromSlug } from "~/models/organization.server";
import { freeCardStepPath, needsCardStep } from "~/services/freeCardStep.server";
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
    if (!(await needsCardStep(org))) {
      return redirect(newProjectPath(organization));
    }

    return typedjson({ organizationSlug: params.organizationSlug });
  }
);

const FormSchema = z.object({ intent: z.enum(["add-card", "skip"]) });

export const action = dashboardAction(routeOptions, async ({ params, request }) => {
  const organization = { slug: params.organizationSlug };
  const { intent } = FormSchema.parse(Object.fromEntries(await request.formData()));
  if (intent === "skip") {
    return redirect(
      newProjectPath(
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
      freeCardStepPath(organization),
      request,
      "We couldn't open the card page. Please try again."
    );
  }
  return redirect(checkout.checkoutUrl);
});

const NEEDS_CARD = [
  "Deploys to Trigger.dev Cloud",
  "Production, staging and preview environments",
  "GitHub and Vercel deploys",
];

const WITHOUT_CARD = [
  "The development environment",
  "Local runs with trigger dev",
  "Runs, logs and traces of your dev runs in the dashboard",
];

export default function FreeCardStepPage() {
  useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submitting = navigation.formData?.get("intent");

  return (
    <AppContainer>
      <PageBody className="bg-background-deep">
        <BackgroundWrapper>
          <div className="mx-auto mt-4 flex h-fit min-h-full w-full max-w-md flex-col items-center justify-center gap-8 lg:mt-0">
            <Header1 className="text-center">Subscribe for full access</Header1>
            <div className="w-full rounded-lg border border-grid-bright bg-background-dimmed p-5 shadow-lg">
              {/* Same shape and height as the Free column of the plan picker. */}
              <div className="flex min-h-[750px] w-full flex-col gap-6 border border-grid-dimmed p-6">
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
                  <Header2>Verify your card to deploy</Header2>
                  <Paragraph variant="small">
                    We don't charge anything: we only verify your card to switch on cloud deploys.
                    Your bank may show a $0–$1 check, released straight away. Just exploring? The
                    dev environment is free to use without a card.
                  </Paragraph>
                </div>
                <FeatureList title="Needs a verified card" items={NEEDS_CARD} available={false} />
                <Form method="post">
                  <input type="hidden" name="intent" value="add-card" />
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
                <FeatureList title="Included without a card" items={WITHOUT_CARD} available />
                <Form method="post" className="mt-auto">
                  <input type="hidden" name="intent" value="skip" />
                  <Button
                    type="submit"
                    variant="secondary/large"
                    fullWidth
                    disabled={submitting !== undefined}
                  >
                    Skip
                  </Button>
                </Form>
              </div>
            </div>
          </div>
        </BackgroundWrapper>
      </PageBody>
    </AppContainer>
  );
}

function FeatureList({
  title,
  items,
  available,
}: {
  title: string;
  items: string[];
  available: boolean;
}) {
  const Icon = available ? CheckCircleIcon : LockClosedIcon;
  return (
    <div className="flex flex-col gap-2">
      <Header3>{title}</Header3>
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <Icon
                className={
                  available ? "size-4 shrink-0 text-success" : "size-4 shrink-0 text-text-dimmed"
                }
              />
              <Paragraph variant="small">{item}</Paragraph>
            </span>
            <Paragraph
              variant="extra-small"
              className={available ? "shrink-0 text-success" : "shrink-0 whitespace-nowrap"}
            >
              {available ? "On" : "Off until verified"}
            </Paragraph>
          </li>
        ))}
      </ul>
    </div>
  );
}
