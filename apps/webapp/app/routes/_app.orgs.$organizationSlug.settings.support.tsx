import { type ActionFunctionArgs, type LoaderFunctionArgs, json, redirect } from "@remix-run/node";
import { Form, useNavigation } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useShowSelfServe } from "~/hooks/useShowSelfServe";
import { requireOrganization } from "~/services/org.server";
import { getCurrentPlan } from "~/services/platform.v3.server";
import {
  enqueueProvisionSupportChannel,
  isPaidPlan,
} from "~/services/supportSlackChannel.server";
import { OrganizationParamsSchema, organizationSupportPath, v3BillingPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { organizationSlug } = OrganizationParamsSchema.parse(params);
  const { organization } = await requireOrganization(request, organizationSlug);

  const supportChannel = await prisma.organizationSupportChannel.findFirst({
    where: { organizationId: organization.id },
  });

  const plan = await getCurrentPlan(organization.id);

  return typedjson({
    organization,
    supportChannel,
    isPaying: isPaidPlan(plan),
  });
};

const ActionSchema = z.object({
  intent: z.literal("connect"),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { organizationSlug } = OrganizationParamsSchema.parse(params);
  const { organization } = await requireOrganization(request, organizationSlug);

  const formData = await request.formData();
  const result = ActionSchema.safeParse({ intent: formData.get("intent") });
  if (!result.success) {
    return json({ error: "Invalid action" }, { status: 400 });
  }

  const plan = await getCurrentPlan(organization.id);
  if (!isPaidPlan(plan)) {
    return json({ error: "Upgrade required" }, { status: 403 });
  }

  await prisma.organizationSupportChannel.upsert({
    where: { organizationId: organization.id },
    create: { organizationId: organization.id, status: "PROVISIONING" },
    update: { status: "PROVISIONING" },
  });

  await enqueueProvisionSupportChannel({ organizationId: organization.id });

  return redirect(organizationSupportPath(organization));
};

export default function Page() {
  const { supportChannel, isPaying } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const showSelfServe = useShowSelfServe();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Slack support channel" />
      </NavBar>
      <PageBody>
        <MainHorizontallyCenteredContainer>
          <Header2 spacing>Private Slack support channel</Header2>
          <Paragraph spacing>
            Get a private Slack channel shared with the Trigger.dev team for direct support.
          </Paragraph>

          {!isPaying ? (
            <div className="flex flex-col gap-3">
              <Paragraph variant="small" className="text-text-dimmed">
                A private Slack support channel is available on paid plans.
              </Paragraph>
              {showSelfServe ? (
                <LinkButton variant="primary/medium" to={v3BillingPath(organization)}>
                  Upgrade to unlock
                </LinkButton>
              ) : (
                <LinkButton variant="secondary/medium" to={v3BillingPath(organization)}>
                  Contact us
                </LinkButton>
              )}
            </div>
          ) : supportChannel?.status === "INVITED" || supportChannel?.status === "LINKED" ? (
            <div className="flex flex-col gap-3">
              <Paragraph variant="small">
                Your private Slack support channel
                {supportChannel.slackChannelName ? ` #${supportChannel.slackChannelName}` : ""} is
                ready.
                {supportChannel.status === "INVITED" && supportChannel.invitedEmail
                  ? ` We've sent a Slack Connect invite to ${supportChannel.invitedEmail}.`
                  : ""}
              </Paragraph>
              {supportChannel.status === "LINKED" ? (
                <Paragraph variant="small">
                  Your support channel is #{supportChannel.slackChannelName}
                </Paragraph>
              ) : null}
              {supportChannel.slackChannelId ? (
                <LinkButton
                  variant="primary/medium"
                  to={`https://slack.com/app_redirect?channel=${supportChannel.slackChannelId}`}
                >
                  Open in Slack
                </LinkButton>
              ) : supportChannel.inviteUrl ? (
                <LinkButton variant="primary/medium" to={supportChannel.inviteUrl}>
                  Join the channel
                </LinkButton>
              ) : null}
            </div>
          ) : supportChannel?.status === "PROVISIONING" ? (
            <Paragraph variant="small" className="text-text-dimmed">
              Setting up your channel — check your email shortly for the Slack Connect invite.
            </Paragraph>
          ) : (
            <Form method="post" className="flex flex-col gap-3">
              {supportChannel?.status === "FAILED" ? (
                <Paragraph variant="small" className="text-error">
                  Something went wrong setting up your channel. Try again, or contact us.
                </Paragraph>
              ) : null}
              <Button
                type="submit"
                name="intent"
                value="connect"
                variant="primary/medium"
                disabled={isSubmitting}
              >
                Connect to Slack
              </Button>
            </Form>
          )}
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
