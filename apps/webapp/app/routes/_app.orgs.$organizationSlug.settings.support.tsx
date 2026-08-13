import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";
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
import { logger } from "~/services/logger.server";
import { getCurrentPlan } from "~/services/platform.v3.server";
import { isSupportChannelEnabled } from "~/services/supportChannelFlag.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { getUserId } from "~/services/session.server";
import {
  enqueueProvisionSupportChannel,
  hasPrivateSlackSupport,
} from "~/services/supportSlackChannel.server";
import {
  OrganizationParamsSchema,
  organizationSupportPath,
  v3BillingPath,
} from "~/utils/pathBuilder";

async function resolveOrg(slug: string, userId: string) {
  // Scoped to membership: ability.can is not a tenant floor (the cloud RBAC
  // plugin returns a permissive ability for a non-member), so without the
  // members filter a non-member reaches the handler for any org slug.
  return prisma.organization.findFirst({
    where: { slug, members: { some: { userId } }, deletedAt: null },
    select: { id: true },
  });
}

async function orgScope(params: { organizationSlug: string }, request: Request) {
  const userId = await getUserId(request);
  if (!userId) return {};
  const org = await resolveOrg(params.organizationSlug, userId);
  return org ? { organizationId: org.id } : {};
}

export const loader = dashboardLoader(
  {
    params: OrganizationParamsSchema,
    context: orgScope,
    // Plan-gated before role-gated: unentitled orgs render the upsell whatever
    // their role, so manage:billing is enforced on the action (and mirrored as
    // a disabled button here) rather than on the whole route.
  },
  async ({ context, ability }) => {
    const organizationId = context.organizationId;
    if (!organizationId) {
      throw new Response("Not Found", { status: 404 });
    }

    // Flag off means the feature does not exist yet, so 404 rather than render
    // an upsell for something nobody can buy.
    if (!(await isSupportChannelEnabled(organizationId))) {
      throw new Response("Not Found", { status: 404 });
    }

    const supportChannel = await prisma.organizationSupportChannel.findFirst({
      where: { organizationId },
    });

    const plan = await getCurrentPlan(organizationId);

    return typedjson({
      supportChannel,
      hasSupportAccess: hasPrivateSlackSupport(plan),
      canManage: ability.can("manage", { type: "billing" }),
    });
  }
);

const ActionSchema = z.object({
  intent: z.literal("connect"),
});

export const action = dashboardAction(
  {
    params: OrganizationParamsSchema,
    context: orgScope,
    authorization: { action: "manage", resource: { type: "billing" } },
  },
  async ({ request, params, context }) => {
    const organizationId = context.organizationId;
    if (!organizationId) {
      throw new Response("Not Found", { status: 404 });
    }

    if (!(await isSupportChannelEnabled(organizationId))) {
      throw new Response("Not Found", { status: 404 });
    }

    const formData = await request.formData();
    const result = ActionSchema.safeParse({ intent: formData.get("intent") });
    if (!result.success) {
      return json({ error: "Invalid action" }, { status: 400 });
    }

    const plan = await getCurrentPlan(organizationId);
    if (!hasPrivateSlackSupport(plan)) {
      return json({ error: "Upgrade required" }, { status: 403 });
    }

    // A live channel already covers this org. Without this an out-of-band POST
    // would flip the row back to PROVISIONING and re-send the Slack invite.
    const existing = await prisma.organizationSupportChannel.findFirst({
      where: { organizationId },
      select: { status: true },
    });
    if (existing?.status === "INVITED" || existing?.status === "LINKED") {
      return redirect(organizationSupportPath({ slug: params.organizationSlug }));
    }

    // Persist before enqueueing. The worker can finish between the two, and if
    // the write came second it would clobber INVITED back to PROVISIONING —
    // leaving the page stuck, with the job already deduped so nothing retries.
    await prisma.organizationSupportChannel.upsert({
      where: { organizationId },
      create: { organizationId, status: "PROVISIONING" },
      update: { status: "PROVISIONING", lastError: null },
    });

    try {
      await enqueueProvisionSupportChannel({ organizationId });
    } catch (error) {
      logger.error("Failed to enqueue support channel provisioning", { organizationId, error });
      await prisma.organizationSupportChannel.update({
        where: { organizationId },
        data: { status: "FAILED", lastError: "Failed to enqueue provisioning" },
      });
      return json({ error: "Failed to start Slack channel provisioning" }, { status: 500 });
    }

    return redirect(organizationSupportPath({ slug: params.organizationSlug }));
  }
);

export default function Page() {
  const { supportChannel, hasSupportAccess, canManage } = useTypedLoaderData<typeof loader>();
  const actionData = useActionData<{ error?: string }>();
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

          {!hasSupportAccess ? (
            <div className="flex flex-col gap-3">
              <Paragraph variant="small" className="text-text-dimmed">
                A private Slack support channel is available on Pro and Enterprise plans.
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
              {/* While INVITED the owner has not joined yet, so the deep link
                  would 404 for them — offer the Slack Connect invite instead.
                  The channel id is always set by then, so ordering matters. */}
              {supportChannel.status === "INVITED" && supportChannel.inviteUrl ? (
                <LinkButton variant="primary/medium" to={supportChannel.inviteUrl}>
                  Join the channel
                </LinkButton>
              ) : supportChannel.slackChannelId ? (
                <LinkButton
                  variant="primary/medium"
                  to={`https://slack.com/app_redirect?channel=${supportChannel.slackChannelId}`}
                >
                  Open in Slack
                </LinkButton>
              ) : null}
            </div>
          ) : supportChannel?.status === "PROVISIONING" ? (
            <Paragraph variant="small" className="text-text-dimmed">
              Setting up your channel. Check your email shortly for the Slack Connect invite.
            </Paragraph>
          ) : (
            <Form method="post" className="flex flex-col gap-3">
              {actionData?.error ? (
                <Paragraph variant="small" className="text-error">
                  {actionData.error}
                </Paragraph>
              ) : null}
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
                disabled={isSubmitting || !canManage}
                tooltip={
                  canManage
                    ? undefined
                    : "You don't have permission to connect a Slack support channel"
                }
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
