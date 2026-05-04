import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { EnvelopeIcon, NoSymbolIcon, UserPlusIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import {
  Form,
  type MetaFunction,
  useActionData,
  useFetcher,
  useNavigation,
} from "@remix-run/react";
import { json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core/utils";
import { useEffect, useRef, useState } from "react";
import { type UseDataFunctionReturn, typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { z } from "zod";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import {
  Alert,
  AlertCancel,
  AlertContent,
  AlertDescription,
  AlertFooter,
  AlertHeader,
  AlertTitle,
  AlertTrigger,
} from "~/components/primitives/Alert";
import { Button, ButtonContent, LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { InputGroup } from "~/components/primitives/InputGroup";
import { InputNumberStepper } from "~/components/primitives/InputNumberStepper";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { Select, SelectItem, SelectLinkItem } from "~/components/primitives/Select";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { $replica } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useUser } from "~/hooks/useUser";
import { removeTeamMember } from "~/models/member.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { TeamPresenter } from "~/presenters/TeamPresenter.server";
import { rbac } from "~/services/rbac.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { cn } from "~/utils/cn";
import { formatCurrency, formatNumber } from "~/utils/numberFormatter";
import {
  inviteTeamMemberPath,
  organizationRolesPath,
  organizationTeamPath,
  resendInvitePath,
  revokeInvitePath,
  v3BillingPath,
} from "~/utils/pathBuilder";
import { SetSeatsAddOnService } from "~/v3/services/setSeatsAddOn.server";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Team | Trigger.dev`,
    },
  ];
};

const Params = z.object({
  organizationSlug: z.string(),
});

// Resolve slug → orgId in the dashboardLoader's context callback so the
// rbac.authenticateSession call gets a real organizationId. The result
// is cached for the duration of the request and reused by the handler
// below (we re-find by slug there to get a typed value — the context
// only sees the loosely typed return type).
async function resolveOrgIdFromSlug(slug: string): Promise<string | null> {
  const org = await $replica.organization.findFirst({
    where: { slug },
    select: { id: true },
  });
  return org?.id ?? null;
}

export const loader = dashboardLoader(
  {
    params: Params,
    context: async (params) => {
      const orgId = await resolveOrgIdFromSlug(params.organizationSlug);
      return orgId ? { organizationId: orgId } : {};
    },
    authorization: { action: "read", resource: { type: "members" } },
  },
  async ({ user, ability, params }) => {
    const orgId = await resolveOrgIdFromSlug(params.organizationSlug);
    if (!orgId) {
      throw new Response("Not Found", { status: 404 });
    }

    const presenter = new TeamPresenter();
    const result = await presenter.call({
      userId: user.id,
      organizationId: orgId,
    });

    if (!result) {
      throw new Response("Not Found", { status: 404 });
    }

    // Pre-compute manage authority server-side so the UI gating matches
    // the action gating (the action enforces it independently).
    const canManageMembers = ability.can("manage", { type: "members" });

    return typedjson({ ...result, canManageMembers });
  }
);

const schema = z.object({
  memberId: z.string(),
});

const PurchaseSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("purchase"),
    amount: z.coerce.number().int("Must be a whole number").min(0, "Amount must be 0 or more"),
  }),
  z.object({
    action: z.literal("quota-increase"),
    amount: z.coerce.number().int("Must be a whole number").min(1, "Amount must be greater than 0"),
  }),
]);

const SetRoleSchema = z.object({
  userId: z.string(),
  roleId: z.string(),
});

export const action = dashboardAction(
  {
    params: Params,
    context: async (params) => {
      const orgId = await resolveOrgIdFromSlug(params.organizationSlug);
      return orgId ? { organizationId: orgId } : {};
    },
    // No top-level authorization — different intents have different
    // requirements (set-role needs manage:members; remove/leave is
    // gated by the existing model layer; purchase-seats by the
    // SetSeatsAddOnService). Per-intent ability checks happen inside.
  },
  async ({ user, ability, request, params }) => {
    const userId = user.id;
    const { organizationSlug } = params;
    invariant(organizationSlug, "organizationSlug not found");

    const formData = await request.formData();
    const formType = formData.get("_formType");

    if (formType === "set-role") {
      if (!ability.can("manage", { type: "members" })) {
        return json({ ok: false, error: "Unauthorized" } as const, { status: 403 });
      }
      const orgId = await resolveOrgIdFromSlug(organizationSlug);
      if (!orgId) {
        return json({ ok: false, error: "Organization not found" } as const, { status: 404 });
      }
      const submission = parse(formData, { schema: SetRoleSchema });
      if (!submission.value || submission.intent !== "submit") {
        return json(submission);
      }
      const result = await rbac.setUserRole({
        userId: submission.value.userId,
        organizationId: orgId,
        roleId: submission.value.roleId,
      });
      if (!result.ok) {
        return json({ ok: false, error: result.error } as const, { status: 400 });
      }
      return json({ ok: true } as const);
    }

    if (formType === "purchase-seats") {
      const org = await $replica.organization.findFirst({
        where: { slug: organizationSlug },
        select: { id: true },
      });

      if (!org) {
        return json({ ok: false, error: "Organization not found" } as const);
      }

      const submission = parse(formData, { schema: PurchaseSchema });

      if (!submission.value || submission.intent !== "submit") {
        return json(submission);
      }

      const service = new SetSeatsAddOnService();
      const [error, result] = await tryCatch(
        service.call({
          userId,
          organizationId: org.id,
          action: submission.value.action,
          amount: submission.value.amount,
        })
      );

      if (error) {
        submission.error.amount = [error instanceof Error ? error.message : "Unknown error"];
        return json(submission);
      }

      if (!result.success) {
        submission.error.amount = [result.error];
        return json(submission);
      }

      return json({ ok: true } as const);
    }

    const submission = parse(formData, { schema });

    if (!submission.value || submission.intent !== "submit") {
      return json(submission);
    }

    try {
      const deletedMember = await removeTeamMember({
        userId,
        memberId: submission.value.memberId,
        slug: organizationSlug,
      });

      if (deletedMember.userId === userId) {
        return redirectWithSuccessMessage("/", request, `You left the organization`);
      }

      return redirectWithSuccessMessage(
        organizationTeamPath(deletedMember.organization),
        request,
        `Removed ${deletedMember.user.name ?? "member"} from team`
      );
    } catch (error: any) {
      return json({ errors: { body: error.message } }, { status: 400 });
    }
  }
);

type Member = UseDataFunctionReturn<typeof loader>["members"][number];
type Invite = UseDataFunctionReturn<typeof loader>["invites"][number];
type Role = UseDataFunctionReturn<typeof loader>["roles"][number];

export default function Page() {
  const {
    members,
    invites,
    limits,
    canPurchaseSeats,
    extraSeats,
    seatPricing,
    maxSeatQuota,
    planSeatLimit,
    roles,
    assignableRoleIds,
    memberRoles,
    canManageMembers,
  } = useTypedLoaderData<typeof loader>();
  // Build a userId → roleId map so the dropdown's defaultValue matches
  // each member's current assignment without re-querying.
  const memberRoleByUserId = new Map<string, string>(
    memberRoles.flatMap((m) => (m.role ? [[m.userId, m.role.id]] : []))
  );
  const user = useUser();
  const organization = useOrganization();

  const plan = useCurrentPlan();
  const requiresUpgrade = limits.used >= limits.limit;
  const usageRatio = limits.limit > 0 ? Math.min(limits.used / limits.limit, 1) : 0;
  const canUpgrade =
    plan?.v3Subscription?.plan && !plan.v3Subscription.plan.limits.teamMembers.canExceed;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Team" />

        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              <Property.Item>
                <Property.Label>Org ID</Property.Label>
                <Property.Value>{organization.id}</Property.Value>
              </Property.Item>

              {members.map((member) => (
                <Property.Item key={member.id}>
                  <Property.Label>{member.user.name}</Property.Label>
                  <Property.Value>
                    <div className="flex items-center gap-2">
                      <Paragraph variant="extra-small/bright/mono">
                        {member.user.email} - {member.user.id}
                      </Paragraph>
                    </div>
                  </Property.Value>
                </Property.Item>
              ))}
            </Property.Table>
          </AdminDebugTooltip>
          {!canManageMembers ? (
            // Gate the invite affordance on manage:members. The action
            // route enforces this independently — hiding it here just
            // avoids dead UI for non-managers.
            <SimpleTooltip
              button={
                <ButtonContent
                  variant="primary/small"
                  LeadingIcon={UserPlusIcon}
                  className="cursor-not-allowed opacity-50"
                >
                  Invite a team member
                </ButtonContent>
              }
              content="You don't have permission to invite team members"
              disableHoverableContent
            />
          ) : requiresUpgrade ? (
            <SimpleTooltip
              button={
                <ButtonContent
                  variant="primary/small"
                  LeadingIcon={UserPlusIcon}
                  className="cursor-not-allowed opacity-50"
                >
                  Invite a team member
                </ButtonContent>
              }
              content="Purchase more seats to invite more team members"
              disableHoverableContent
            />
          ) : (
            <LinkButton
              to={inviteTeamMemberPath(organization)}
              variant="primary/small"
              LeadingIcon={UserPlusIcon}
            >
              Invite a team member
            </LinkButton>
          )}
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid max-h-full min-h-full grid-rows-[1fr_auto]">
          <div className="overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            <div className="mx-auto max-w-3xl px-4 pb-4 pt-20">
              {invites.length > 0 && (
                <>
                  <Header2 className="mb-3 mt-4">Pending invites</Header2>
                  <ul className="divide-ui-border mb-6 flex w-full flex-col divide-y border-y">
                    {invites.map((invite) => (
                      <li key={invite.id} className="flex items-center gap-4 py-4">
                        <div className="rounded-md border border-charcoal-750 bg-charcoal-800 p-1.5">
                          <EnvelopeIcon className="size-7 text-text-dimmed" />
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <Header3>{invite.email}</Header3>
                          <Paragraph variant="small">
                            Invite sent {<DateTime date={invite.updatedAt} />}
                          </Paragraph>
                        </div>
                        <div className="flex grow items-center justify-end gap-x-2">
                          <ResendButton invite={invite} />
                          <RevokeButton invite={invite} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className="mt-4 flex items-baseline justify-between">
                <Header2>Active team members</Header2>
                {roles.length > 0 ? (
                  <a
                    className="text-xs text-text-link hover:underline"
                    href={organizationRolesPath(organization)}
                  >
                    View all role permissions →
                  </a>
                ) : null}
              </div>
              <div className="mb-8 mt-3 grid w-full grid-cols-[1fr_auto_auto] items-center gap-x-2 border-y border-grid-bright">
                {members.map((member) => (
                  <div
                    key={member.user.id}
                    className="col-span-3 grid grid-cols-subgrid items-center gap-x-2 border-b border-grid-bright py-2 last:border-b-0"
                  >
                    <div className="flex items-center gap-x-2">
                      <UserAvatar
                        avatarUrl={member.user.avatarUrl}
                        name={member.user.name}
                        className="size-10"
                      />
                      <div className="flex flex-col gap-0.5">
                        <Header3>
                          {member.user.name}{" "}
                          {member.user.id === user.id && (
                            <span className="text-text-dimmed">(You)</span>
                          )}
                        </Header3>
                        <Paragraph variant="small">{member.user.email}</Paragraph>
                      </div>
                    </div>
                    <RolePicker
                      memberUserId={member.user.id}
                      currentRoleId={memberRoleByUserId.get(member.user.id) ?? null}
                      roles={roles}
                      assignableRoleIds={assignableRoleIds}
                      canManageMembers={canManageMembers}
                    />
                    <div className="justify-self-end">
                      <LeaveRemoveButton
                        userId={user.id}
                        member={member}
                        memberCount={members.length}
                        canManageMembers={canManageMembers}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex h-fit w-full items-center gap-3 border-t border-grid-bright bg-background-bright p-[0.86rem] pl-4">
            <SimpleTooltip
              button={
                <div className="size-6">
                  <svg className="h-full w-full -rotate-90 overflow-visible">
                    <circle
                      className="fill-none stroke-grid-bright"
                      strokeWidth="4"
                      r="10"
                      cx="12"
                      cy="12"
                    />
                    <circle
                      className={`fill-none ${requiresUpgrade ? "stroke-error" : "stroke-success"}`}
                      strokeWidth="4"
                      r="10"
                      cx="12"
                      cy="12"
                      strokeDasharray={`${usageRatio * 62.8} 62.8`}
                      strokeDashoffset="0"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              }
              content={`${Math.round(usageRatio * 100)}%`}
            />
            <div className="flex w-full items-center justify-between gap-6">
              {requiresUpgrade ? (
                <Header3 className="text-error">
                  You've used all {limits.limit} of your seats.{" "}
                  {canPurchaseSeats
                    ? "Purchase more seats to invite more team members."
                    : "Upgrade your plan to invite more team members."}
                </Header3>
              ) : (
                <Header3>
                  You've used {limits.used}/{limits.limit} of your seats
                </Header3>
              )}
              {canPurchaseSeats && seatPricing ? (
                <PurchaseSeatsModal
                  seatPricing={seatPricing}
                  extraSeats={extraSeats}
                  usedSeats={limits.used}
                  maxQuota={maxSeatQuota}
                  planSeatLimit={planSeatLimit}
                />
              ) : canUpgrade ? (
                <LinkButton to={v3BillingPath(organization)} variant="primary/small">
                  Upgrade
                </LinkButton>
              ) : null}
            </div>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function LeaveRemoveButton({
  userId,
  member,
  memberCount,
  canManageMembers,
}: {
  userId: string;
  member: Member;
  memberCount: number;
  canManageMembers: boolean;
}) {
  const organization = useOrganization();

  if (userId === member.user.id) {
    if (memberCount === 1) {
      return (
        <SimpleTooltip
          button={
            <ButtonContent variant="minimal/small" className="cursor-not-allowed">
              Leave team
            </ButtonContent>
          }
          disableHoverableContent
          content="An organization requires at least 1 team member"
        />
      );
    }

    //you leave the team — leaving is always permitted regardless of
    //manage:members; non-managers can still leave on their own.
    return (
      <LeaveTeamModal
        member={member}
        buttonText="Leave team"
        title="Are you sure you want to leave the team?"
        description={`You will no longer have access to ${organization.title}. To regain access, you will need to be invited again.`}
        actionText="Leave team"
      />
    );
  }

  //you remove another member — requires manage:members
  if (!canManageMembers) {
    return (
      <SimpleTooltip
        button={
          <ButtonContent variant="secondary/small" className="cursor-not-allowed opacity-50">
            Remove from team
          </ButtonContent>
        }
        disableHoverableContent
        content="You don't have permission to remove team members"
      />
    );
  }
  return (
    <LeaveTeamModal
      member={member}
      buttonText="Remove from team"
      title={`Are you sure you want to remove ${member.user.name ?? "them"} from the team?`}
      description={`They will no longer have access to ${organization.title}. To regain access, you will need to invite them again.`}
      actionText="Remove from team"
    />
  );
}

// Inline role picker — submits a `_formType=set-role` form via fetcher
// so the change persists without a full page reload. Disabled options
// (and the picker itself) reflect plan gating + manage:members; the
// server's setUserRole enforces both checks again as the source of
// truth, so this is a UI-affordance layer only.
function RolePicker({
  memberUserId,
  currentRoleId,
  roles,
  assignableRoleIds,
  canManageMembers,
}: {
  memberUserId: string;
  currentRoleId: string | null;
  roles: Role[];
  assignableRoleIds: string[];
  canManageMembers: boolean;
}) {
  const organization = useOrganization();
  const fetcher = useFetcher<{ ok: boolean; error?: string } | { ok: true }>();
  const assignable = new Set(assignableRoleIds);
  // With no RBAC plugin installed, the loader returns no roles —
  // render nothing rather than an empty dropdown.
  if (roles.length === 0) return null;

  const isSubmitting = fetcher.state === "submitting";
  const error =
    fetcher.data && "error" in fetcher.data && fetcher.data.error ? fetcher.data.error : null;

  const picker = (
    <Select
      defaultValue={currentRoleId ?? ""}
      items={roles}
      variant="tertiary/small"
      disabled={!canManageMembers || isSubmitting}
      dropdownIcon
      text={(v) => roles.find((r) => r.id === v)?.name ?? "No role"}
      setValue={(next) => {
        if (typeof next !== "string" || next === (currentRoleId ?? "")) return;
        // Upgrade-link rows have a value too (Ariakit needs one to
        // make the row interactive — without it the Link inside
        // doesn't even register the click), but they shouldn't
        // submit the role-change form. The Link navigates the user
        // to the plan-selection page; we just bail here.
        if (!assignable.has(next)) return;
        fetcher.submit(
          { _formType: "set-role", userId: memberUserId, roleId: next },
          { method: "post" }
        );
      }}
    >
      {(items) =>
        items.map((role) => {
          const isAssignable = assignable.has(role.id);
          return isAssignable ? (
            <SelectItem key={role.id} value={role.id}>
              {role.name}
            </SelectItem>
          ) : (
            <SelectLinkItem key={role.id} value={role.id} to={v3BillingPath(organization)}>
              {role.name} (upgrade)
            </SelectLinkItem>
          );
        })
      }
    </Select>
  );

  return (
    <div className="flex flex-col items-end gap-1">
      {canManageMembers ? (
        picker
      ) : (
        // Disabled <Select> swallows hover events on its own, so wrap it
        // in a div the tooltip can attach to.
        <SimpleTooltip
          button={<div className="cursor-not-allowed">{picker}</div>}
          content="You don't have permission to change roles"
          disableHoverableContent
        />
      )}
      {error ? (
        <span className="text-xs text-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function LeaveTeamModal({
  member,
  buttonText,
  title,
  description,
  actionText,
}: {
  member: Member;
  buttonText: string;
  title: string;
  description: string;
  actionText: string;
}) {
  const [open, setOpen] = useState(false);
  const lastSubmission = useActionData();

  const [form, { memberId }] = useForm({
    id: "remove-member",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  return (
    <Alert open={open} onOpenChange={(o) => setOpen(o)}>
      <AlertTrigger asChild>
        <Button variant="secondary/small">{buttonText}</Button>
      </AlertTrigger>
      <AlertContent>
        <AlertHeader>
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>{description}</AlertDescription>
        </AlertHeader>
        <AlertFooter>
          <AlertCancel asChild>
            <Button variant="secondary/small">Cancel</Button>
          </AlertCancel>
          <Form method="post" {...form.props} onSubmit={() => setOpen(false)}>
            <input type="hidden" value={member.id} name="memberId" />
            <Button type="submit" variant="danger/small" form={form.props.id}>
              {actionText}
            </Button>
          </Form>
        </AlertFooter>
      </AlertContent>
    </Alert>
  );
}

const RESEND_COOLDOWN_SECONDS = 30;

function initialCooldown(updatedAt: Date | string): number {
  const elapsed = Math.floor((Date.now() - new Date(updatedAt).getTime()) / 1000);
  const remaining = RESEND_COOLDOWN_SECONDS - elapsed;
  return remaining > 0 ? remaining : 0;
}

function ResendButton({ invite }: { invite: Invite }) {
  const navigation = useNavigation();
  const isSubmitting =
    navigation.state === "submitting" &&
    navigation.formAction === resendInvitePath() &&
    navigation.formData?.get("inviteId") === invite.id;
  const prevSubmitting = useRef(false);
  const [cooldown, setCooldown] = useState(() => initialCooldown(invite.updatedAt));
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    if (prevSubmitting.current && !isSubmitting) {
      setCooldown(RESEND_COOLDOWN_SECONDS);
    }
    prevSubmitting.current = isSubmitting;
  }, [isSubmitting]);

  const cooldownActive = cooldown > 0;
  useEffect(() => {
    if (!cooldownActive) return;

    intervalRef.current = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) {
          clearInterval(intervalRef.current);
          return 0;
        }
        return c - 1;
      });
    }, 1000);

    return () => clearInterval(intervalRef.current);
  }, [cooldownActive]);

  const isDisabled = isSubmitting || cooldown > 0;

  return (
    <Form method="post" action={resendInvitePath()} className="flex">
      <input type="hidden" value={invite.id} name="inviteId" />
      <Button type="submit" variant="secondary/small" disabled={isDisabled}>
        {isSubmitting ? (
          "Sending…"
        ) : cooldown > 0 ? (
          <span className="tabular-nums">{`Sent – resend in ${cooldown}s`}</span>
        ) : (
          "Resend invite"
        )}
      </Button>
    </Form>
  );
}

function RevokeButton({ invite }: { invite: Invite }) {
  const organization = useOrganization();

  return (
    <Form method="post" action={revokeInvitePath()} className="flex">
      <input type="hidden" value={invite.id} name="inviteId" />
      <input type="hidden" value={organization.slug} name="slug" />
      <SimpleTooltip
        button={
          <Button
            type="submit"
            variant="danger/small"
            LeadingIcon={NoSymbolIcon}
            leadingIconClassName="text-white"
            aria-label="Revoke invite"
          />
        }
        content="Revoke invite"
        disableHoverableContent
        asChild
      />
    </Form>
  );
}

export function PurchaseSeatsModal({
  seatPricing,
  extraSeats,
  usedSeats,
  maxQuota,
  planSeatLimit,
  triggerButton,
}: {
  seatPricing: {
    stepSize: number;
    centsPerStep: number;
  };
  extraSeats: number;
  usedSeats: number;
  maxQuota: number;
  planSeatLimit: number;
  triggerButton?: React.ReactElement;
}) {
  const fetcher = useFetcher();
  const organization = useOrganization();
  const lastSubmission =
    fetcher.data && typeof fetcher.data === "object" && "intent" in fetcher.data
      ? fetcher.data
      : undefined;
  const [form, { amount }] = useForm({
    id: "purchase-seats",
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: PurchaseSchema });
    },
    shouldRevalidate: "onSubmit",
  });

  const [amountValue, setAmountValue] = useState(extraSeats);
  useEffect(() => {
    setAmountValue(extraSeats);
  }, [extraSeats]);
  const isLoading = fetcher.state !== "idle";

  const [open, setOpen] = useState(false);
  useEffect(() => {
    const data = fetcher.data;
    if (
      fetcher.state === "idle" &&
      data !== null &&
      typeof data === "object" &&
      "ok" in data &&
      data.ok
    ) {
      setOpen(false);
    }
  }, [fetcher.state, fetcher.data]);

  const state = updateSeatState({
    value: amountValue,
    existingValue: extraSeats,
    quota: maxQuota,
    usedSeats,
    planSeatLimit,
  });
  const changeClassName =
    state === "decrease" ? "text-error" : state === "increase" ? "text-success" : undefined;

  const pricePerSeat = seatPricing.centsPerStep / seatPricing.stepSize / 100;
  const title = extraSeats === 0 ? "Purchase extra seats…" : "Add/remove extra seats…";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {triggerButton ?? (
          <Button variant="primary/small" onClick={() => setOpen(true)}>
            {title}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>{title}</DialogHeader>
        <fetcher.Form method="post" action={organizationTeamPath(organization)} {...form.props}>
          <input type="hidden" name="_formType" value="purchase-seats" />
          <div className="flex flex-col gap-4 pt-2">
            <div className="flex flex-col gap-1">
              <Paragraph variant="small/bright">
                Purchase extra seats at {formatCurrency(pricePerSeat, true)}/month per seat.
                Reducing seats will take effect at the start of your next billing cycle (on the 1st
                of the month).
              </Paragraph>
            </div>
            <Fieldset>
              <InputGroup fullWidth>
                <Label htmlFor="amount" className="text-text-dimmed">
                  Total extra seats
                </Label>
                <InputNumberStepper
                  {...conform.input(amount, { type: "number" })}
                  step={seatPricing.stepSize}
                  min={0}
                  max={undefined}
                  value={amountValue}
                  onChange={(e) => setAmountValue(Number(e.target.value))}
                  disabled={isLoading}
                />
                <FormError id={amount.errorId}>
                  {amount.error ?? amount.initialError?.[""]?.[0]}
                </FormError>
                <FormError>{form.error}</FormError>
              </InputGroup>
            </Fieldset>
            {state === "need_to_remove_members" ? (
              <div className="flex flex-col pb-3">
                <Paragraph variant="small" className="text-warning" spacing>
                  You need to remove {formatNumber(usedSeats - (planSeatLimit + amountValue))}{" "}
                  {usedSeats - (planSeatLimit + amountValue) === 1
                    ? "team member or pending invite"
                    : "team members or pending invites"}{" "}
                  before you can reduce to this level.
                </Paragraph>
              </div>
            ) : state === "above_quota" ? (
              <div className="flex flex-col pb-3">
                <Paragraph variant="small" className="text-warning" spacing>
                  Currently you can only have up to {maxQuota} extra seats. Send a request below to
                  lift your current limit. We'll get back to you soon.
                </Paragraph>
              </div>
            ) : (
              <div className="flex flex-col pb-3 tabular-nums">
                <div className="grid grid-cols-2 border-b border-grid-dimmed pb-1">
                  <Header3 className="font-normal text-text-dimmed">Summary</Header3>
                  <Header3 className="justify-self-end font-normal text-text-dimmed">Total</Header3>
                </div>
                <div className="grid grid-cols-2 pt-2">
                  <Header3 className="pb-0 font-normal text-text-dimmed">
                    <span className="text-text-bright">{formatNumber(extraSeats)}</span> current
                    extra
                  </Header3>
                  <Header3 className="justify-self-end font-normal text-text-bright">
                    {formatCurrency(extraSeats * pricePerSeat, true)}
                  </Header3>
                </div>
                <div className="grid grid-cols-2 text-xs">
                  <span className="text-text-dimmed">
                    ({extraSeats} {extraSeats === 1 ? "seat" : "seats"})
                  </span>
                  <span className="justify-self-end text-text-dimmed">/mth</span>
                </div>
                <div className="grid grid-cols-2 pt-2">
                  <Header3 className={cn("pb-0 font-normal", changeClassName)}>
                    {state === "increase" ? "+" : null}
                    {formatNumber(amountValue - extraSeats)}
                  </Header3>
                  <Header3 className={cn("justify-self-end font-normal", changeClassName)}>
                    {state === "increase" ? "+" : null}
                    {formatCurrency((amountValue - extraSeats) * pricePerSeat, true)}
                  </Header3>
                </div>
                <div className="grid grid-cols-2 text-xs">
                  <span className="text-text-dimmed">
                    ({Math.abs(amountValue - extraSeats)}{" "}
                    {Math.abs(amountValue - extraSeats) === 1 ? "seat" : "seats"} @{" "}
                    {formatCurrency(pricePerSeat, true)}/mth)
                  </span>
                  <span className="justify-self-end text-text-dimmed">/mth</span>
                </div>
                <div className="grid grid-cols-2 pt-2">
                  <Header3 className="pb-0 font-normal text-text-dimmed">
                    <span className="text-text-bright">{formatNumber(amountValue)}</span> new total
                  </Header3>
                  <Header3 className="justify-self-end font-normal text-text-bright">
                    {formatCurrency(amountValue * pricePerSeat, true)}
                  </Header3>
                </div>
                <div className="grid grid-cols-2 text-xs">
                  <span className="text-text-dimmed">
                    ({amountValue} {amountValue === 1 ? "seat" : "seats"})
                  </span>
                  <span className="justify-self-end text-text-dimmed">/mth</span>
                </div>
              </div>
            )}
          </div>
          <FormButtons
            confirmButton={
              state === "above_quota" ? (
                <>
                  <input type="hidden" name="action" value="quota-increase" />
                  <Button
                    LeadingIcon={isLoading ? SpinnerWhite : EnvelopeIcon}
                    variant="primary/medium"
                    type="submit"
                    disabled={isLoading}
                  >
                    <span className="tabular-nums text-text-bright">{`Send request for ${formatNumber(
                      amountValue
                    )}`}</span>
                  </Button>
                </>
              ) : state === "decrease" || state === "need_to_remove_members" ? (
                <>
                  <input type="hidden" name="action" value="purchase" />
                  <Button
                    variant="danger/medium"
                    type="submit"
                    disabled={isLoading || state === "need_to_remove_members"}
                    LeadingIcon={isLoading ? SpinnerWhite : undefined}
                  >
                    <span className="tabular-nums text-text-bright">{`Remove ${formatNumber(
                      extraSeats - amountValue
                    )} ${extraSeats - amountValue === 1 ? "seat" : "seats"}`}</span>
                  </Button>
                </>
              ) : (
                <>
                  <input type="hidden" name="action" value="purchase" />
                  <Button
                    variant="primary/medium"
                    type="submit"
                    disabled={isLoading || state === "no_change"}
                    LeadingIcon={isLoading ? SpinnerWhite : undefined}
                  >
                    <span className="tabular-nums text-text-bright">{`Purchase ${formatNumber(
                      amountValue - extraSeats
                    )} ${amountValue - extraSeats === 1 ? "seat" : "seats"}`}</span>
                  </Button>
                </>
              )
            }
            cancelButton={
              <DialogClose asChild>
                <Button variant="secondary/medium" disabled={isLoading}>
                  Cancel
                </Button>
              </DialogClose>
            }
          />
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

function updateSeatState({
  value,
  existingValue,
  quota,
  usedSeats,
  planSeatLimit,
}: {
  value: number;
  existingValue: number;
  quota: number;
  usedSeats: number;
  planSeatLimit: number;
}): "no_change" | "increase" | "decrease" | "above_quota" | "need_to_remove_members" {
  if (value === existingValue) return "no_change";
  if (value < existingValue) {
    const newTotalLimit = planSeatLimit + value;
    if (usedSeats > newTotalLimit) {
      return "need_to_remove_members";
    }
    return "decrease";
  }
  if (value > quota) return "above_quota";
  return "increase";
}
