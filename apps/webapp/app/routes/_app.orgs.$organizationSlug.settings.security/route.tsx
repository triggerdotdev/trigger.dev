import { useFetcher } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Callout } from "~/components/primitives/Callout";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Select, SelectItem } from "~/components/primitives/Select";
import {
  SettingsContainer,
  SettingsHeader,
  SettingsRow,
  SettingsSection,
} from "~/components/primitives/SettingsLayout";
import { Switch } from "~/components/primitives/Switch";
import { TextLink } from "~/components/primitives/TextLink";
import { prisma } from "~/db.server";
import { jsonWithErrorMessage, jsonWithSuccessMessage } from "~/models/message.server";
import { getImpersonationState } from "~/services/impersonation.server";
import { requireRecentMfa } from "~/services/mfa/mfaPolicy.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { getUserId } from "~/services/session.server";
import {
  MFA_STEP_UP_ACTIONS,
  MFA_STEP_UP_WINDOW_MINUTES,
  type MfaStepUpAction,
} from "~/utils/mfaStepUp";
import { pageMeta } from "~/utils/pageTitle";
import { accountSecurityPath } from "~/utils/pathBuilder";

export const meta = pageMeta("Security");

const Params = z.object({ organizationSlug: z.string() });

const authorization = { action: "manage", resource: { type: "mfa" } } as const;

const ActionSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("setRequired"), enabled: z.enum(["true", "false"]) }),
  z.object({
    intent: z.literal("setStepUpAction"),
    stepUpAction: z.enum(MFA_STEP_UP_ACTIONS),
    enabled: z.enum(["true", "false"]),
  }),
  z.object({
    intent: z.literal("setWindow"),
    minutes: z.coerce
      .number()
      .refine((m) => (MFA_STEP_UP_WINDOW_MINUTES as readonly number[]).includes(m)),
  }),
]);

const STEP_UP_ACTIONS: Record<MfaStepUpAction, { title: string; description: string }> = {
  environmentVariables: {
    title: "Environment variables",
    description: "Viewing, creating and editing environment variables.",
  },
  accessTokens: {
    title: "Personal access tokens",
    description: "Creating personal access tokens and approving CLI logins.",
  },
  organizationSecurity: {
    title: "Security settings",
    description: "Viewing and changing these MFA settings.",
  },
};

// Scoped to membership: ability.can is not a tenant floor.
async function context(params: z.infer<typeof Params>, request: Request) {
  const userId = await getUserId(request);
  if (!userId) return {};
  const org = await prisma.organization.findFirst({
    where: { slug: params.organizationSlug, deletedAt: null, members: { some: { userId } } },
    select: { id: true },
  });
  return org ? { organizationId: org.id } : {};
}

export const loader = dashboardLoader(
  { params: Params, context, authorization },
  async ({ request, context, user }) => {
    if (!context.organizationId) throw new Response("Not Found", { status: 404 });
    await requireRecentMfa(request, {
      userId: user.id,
      action: "organizationSecurity",
      organizationId: context.organizationId,
    });

    const [org, currentUser] = await Promise.all([
      prisma.organization.findFirst({
        where: { id: context.organizationId },
        select: { mfaRequired: true, mfaStepUpActions: true, mfaStepUpWindowMinutes: true },
      }),
      prisma.user.findFirst({ where: { id: user.id }, select: { mfaEnabledAt: true } }),
    ]);
    if (!org) throw new Response("Not Found", { status: 404 });

    return typedjson({
      ...org,
      userHasMfa: !!currentUser?.mfaEnabledAt,
      readOnly: (await getImpersonationState(request, user.id)).isImpersonating,
    });
  }
);

export const action = dashboardAction(
  { params: Params, context, authorization },
  async ({ request, context, user }) => {
    const organizationId = context.organizationId;
    if (!organizationId) throw new Response("Not Found", { status: 404 });

    if ((await getImpersonationState(request, user.id)).isImpersonating) {
      return jsonWithErrorMessage(
        { ok: false },
        request,
        "Security settings can't be changed while impersonating."
      );
    }
    await requireRecentMfa(request, {
      userId: user.id,
      action: "organizationSecurity",
      organizationId,
    });

    const parsed = ActionSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) return new Response("Bad Request", { status: 400 });
    const input = parsed.data;

    switch (input.intent) {
      case "setRequired": {
        const enabled = input.enabled === "true";
        // Requiring MFA without having it would lock the owner out on the next request.
        const currentUser = await prisma.user.findFirst({
          where: { id: user.id },
          select: { mfaEnabledAt: true },
        });
        if (enabled && !currentUser?.mfaEnabledAt) {
          return jsonWithErrorMessage(
            { ok: false },
            request,
            "Turn on multi-factor authentication for your own account first."
          );
        }
        await prisma.organization.update({
          where: { id: organizationId },
          data: { mfaRequired: enabled },
        });
        return jsonWithSuccessMessage({ ok: true }, request, "Saved.");
      }
      case "setStepUpAction": {
        const action = input.stepUpAction;
        if (input.enabled === "true") {
          // One atomic update, so two owners toggling different actions don't overwrite each other.
          await prisma.$executeRaw`UPDATE "Organization" SET "mfaStepUpActions" = array_append(array_remove("mfaStepUpActions", ${action}), ${action}), "updatedAt" = NOW() WHERE "id" = ${organizationId}`;
          return jsonWithSuccessMessage({ ok: true }, request, "Saved.");
        }
        // Turning a check off needs that check to have passed, judged before the change.
        await requireRecentMfa(request, { userId: user.id, action, organizationId });
        await prisma.$executeRaw`UPDATE "Organization" SET "mfaStepUpActions" = array_remove("mfaStepUpActions", ${action}), "updatedAt" = NOW() WHERE "id" = ${organizationId}`;
        return jsonWithSuccessMessage({ ok: true }, request, "Saved.");
      }
      case "setWindow": {
        // A longer window would revive an expired check, so judge it under the current window.
        const org = await prisma.organization.findFirst({
          where: { id: organizationId },
          select: { mfaStepUpActions: true },
        });
        const guarded = MFA_STEP_UP_ACTIONS.find((a) => org?.mfaStepUpActions.includes(a));
        if (guarded) {
          await requireRecentMfa(request, { userId: user.id, action: guarded, organizationId });
        }
        await prisma.organization.update({
          where: { id: organizationId },
          data: { mfaStepUpWindowMinutes: input.minutes },
        });
        return jsonWithSuccessMessage({ ok: true }, request, "Saved.");
      }
    }
  }
);

const WINDOW_ITEMS = MFA_STEP_UP_WINDOW_MINUTES.map((minutes) => ({
  value: String(minutes),
  label: minutes === 60 ? "1 hour" : `${minutes} minutes`,
}));

export default function Page() {
  const { mfaRequired, mfaStepUpActions, mfaStepUpWindowMinutes, userHasMfa, readOnly } =
    useTypedLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const submit = (data: Record<string, string>) => fetcher.submit(data, { method: "post" });

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Security" />
      </NavBar>
      <PageBody scrollable={true}>
        <SettingsContainer className="max-w-[60rem]">
          <SettingsSection>
            <SettingsHeader
              title="Multi-factor authentication"
              description="Require every member of this organization to use multi-factor authentication."
            />
            {readOnly && (
              <Callout variant="info" className="mt-4">
                You're impersonating this organization, so these settings are read-only.
              </Callout>
            )}
            <SettingsRow
              title="Require MFA for all members"
              description={
                userHasMfa || mfaRequired ? (
                  "Members without MFA are asked to set it up and can't use the dashboard, CLI or API with their personal access tokens until they do. Members can't turn MFA off."
                ) : (
                  <>
                    Turn on multi-factor authentication for{" "}
                    <TextLink to={accountSecurityPath()}>your own account</TextLink> before
                    requiring it.
                  </>
                )
              }
              action={
                <Switch
                  variant="medium"
                  checked={mfaRequired}
                  disabled={readOnly || (!userHasMfa && !mfaRequired)}
                  onCheckedChange={(enabled) =>
                    submit({ intent: "setRequired", enabled: String(enabled) })
                  }
                />
              }
            />
          </SettingsSection>

          <SettingsSection>
            <SettingsHeader
              title="Actions that require an MFA check"
              description="Members are asked for a code from their authenticator app before these actions. Members without MFA must set it up first."
            />
            {MFA_STEP_UP_ACTIONS.map((stepUpAction) => (
              <SettingsRow
                key={stepUpAction}
                title={STEP_UP_ACTIONS[stepUpAction].title}
                description={STEP_UP_ACTIONS[stepUpAction].description}
                action={
                  <Switch
                    variant="medium"
                    checked={mfaStepUpActions.includes(stepUpAction)}
                    disabled={readOnly}
                    onCheckedChange={(enabled) =>
                      submit({ intent: "setStepUpAction", stepUpAction, enabled: String(enabled) })
                    }
                  />
                }
              />
            ))}
            <SettingsRow
              title="Ask again after"
              description="How long a passed check lasts before members are asked again."
              action={
                <Select
                  value={String(mfaStepUpWindowMinutes)}
                  setValue={(minutes) => submit({ intent: "setWindow", minutes })}
                  items={WINDOW_ITEMS}
                  variant="secondary/small"
                  dropdownIcon
                  disabled={readOnly}
                  placement="bottom-end"
                  text={(value) => WINDOW_ITEMS.find((item) => item.value === value)?.label ?? ""}
                >
                  {(items) =>
                    items.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))
                  }
                </Select>
              }
            />
          </SettingsSection>
        </SettingsContainer>
      </PageBody>
    </PageContainer>
  );
}
