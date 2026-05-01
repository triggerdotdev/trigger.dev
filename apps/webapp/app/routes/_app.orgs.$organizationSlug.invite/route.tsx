import { conform, list, requestIntent, useFieldList, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import {
  ArrowUpCircleIcon,
  EnvelopeIcon,
  LockOpenIcon,
  UserPlusIcon,
} from "@heroicons/react/20/solid";
import type { ActionFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { Fragment, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import simplur from "simplur";
import invariant from "tiny-invariant";
import { z } from "zod";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { FormTitle } from "~/components/primitives/FormTitle";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { inviteMembers } from "~/models/member.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { TeamPresenter } from "~/presenters/TeamPresenter.server";
import { scheduleEmail } from "~/services/email.server";
import { rbac } from "~/services/rbac.server";
import { requireUserId } from "~/services/session.server";
import { acceptInvitePath, organizationTeamPath, v3BillingPath } from "~/utils/pathBuilder";
import { PurchaseSeatsModal } from "../_app.orgs.$organizationSlug.settings.team/route";

const Params = z.object({
  organizationSlug: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = Params.parse(params);

  const organization = await $replica.organization.findFirst({
    where: { slug: organizationSlug },
    select: { id: true },
  });

  if (!organization) {
    throw new Response("Not Found", { status: 404 });
  }

  const presenter = new TeamPresenter();
  const result = await presenter.call({
    userId,
    organizationId: organization.id,
  });

  if (!result) {
    throw new Response("Not Found", { status: 404 });
  }

  // Inviter's own role drives the "below their level" filter on the
  // dropdown. Plus assignable role IDs already encode the org's plan
  // tier — the intersection is what we offer.
  const [inviterRole, assignableRoleIds, systemRoles] = await Promise.all([
    rbac.getUserRole({ userId, organizationId: organization.id }),
    rbac.getAssignableRoleIds(organization.id),
    rbac.systemRoles(organization.id),
  ]);

  // Build the dropdown's offerable set server-side: roles that are
  // (a) assignable on the current plan AND (b) strictly below the
  // inviter's own level. The client just renders these — it doesn't
  // need to know about the system-role catalogue or the ladder.
  const assignableSet = new Set(assignableRoleIds);
  const offerableRoleIds = systemRoles
    ? result.roles
        .filter(
          (r) =>
            assignableSet.has(r.id) &&
            isStrictlyBelow(systemRoles, inviterRole?.id ?? null, r.id)
        )
        .map((r) => r.id)
    : [];

  return typedjson({ ...result, offerableRoleIds });
};

// Sentinel for "no RBAC role attached to invite" — the runtime
// fallback will derive a role from the legacy OrgMember.role write at
// accept time. Used when the org has no RBAC plugin installed (the
// dropdown is hidden) or as a defensive default.
const NO_RBAC_ROLE = "__no_rbac_role__";

// An inviter can only assign a role strictly below their own. The
// plugin's systemRoles array is in canonical order (highest authority
// first), so array index drives the ladder — earlier index = higher
// rank. Plan-tier filtering happens separately via assignableRoleIds;
// the ladder is the absolute hierarchy. Custom roles aren't in the
// table and are refused (TRI-8747's follow-up will handle them).
type LadderRole = { id: string };

function buildRoleLevel(roles: ReadonlyArray<LadderRole>): Record<string, number> {
  const level: Record<string, number> = {};
  roles.forEach((r, i) => {
    // Top of the array = highest level. Subtract from length so larger
    // numbers always mean "more authority" — no off-by-one when a role
    // is added or removed.
    level[r.id] = roles.length - i;
  });
  return level;
}

function isStrictlyBelow(
  roles: ReadonlyArray<LadderRole>,
  inviterRoleId: string | null,
  invitedRoleId: string
): boolean {
  // No RBAC role on inviter (e.g. the runtime fallback couldn't derive
  // one) → fall back to the legacy OrgMember.role check the calling
  // code already enforces. Allow the invite to proceed; the action
  // would have already failed earlier if the inviter wasn't allowed
  // to invite at all.
  if (!inviterRoleId) return true;
  const level = buildRoleLevel(roles);
  const inviter = level[inviterRoleId];
  const invited = level[invitedRoleId];
  // Custom roles aren't in the level table — refuse.
  if (inviter === undefined || invited === undefined) return false;
  return invited < inviter;
}

const schema = z.object({
  emails: z.preprocess((i) => {
    if (typeof i === "string") return [i];

    if (Array.isArray(i)) {
      const emails = i.filter((v) => typeof v === "string" && v !== "");
      if (emails.length === 0) {
        return [""];
      }
      return emails;
    }

    return [""];
  }, z.string().email().array().nonempty("At least one email is required")),
  rbacRoleId: z.string().optional(),
});

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug is required");

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  // Resolve the RBAC role choice. NO_RBAC_ROLE / undefined / unknown
  // role → don't pass one through; the runtime fallback handles it.
  // Validation: the chosen role must be in the org's assignable set
  // (plan-tier) and strictly below the inviter's own level.
  let resolvedRbacRoleId: string | null = null;
  const submittedRbacRoleId = submission.value.rbacRoleId;
  if (
    submittedRbacRoleId &&
    submittedRbacRoleId !== NO_RBAC_ROLE
  ) {
    const org = await $replica.organization.findFirst({
      where: { slug: organizationSlug },
      select: { id: true },
    });
    if (!org) {
      return json({ errors: { body: "Organization not found" } }, { status: 404 });
    }
    const [inviterRole, assignableRoleIds, systemRoles] = await Promise.all([
      rbac.getUserRole({ userId, organizationId: org.id }),
      rbac.getAssignableRoleIds(org.id),
      rbac.systemRoles(org.id),
    ]);
    if (!systemRoles) {
      // No plugin installed but the form somehow submitted a role id —
      // ignore it (fall through to legacy behaviour rather than 400).
      resolvedRbacRoleId = null;
    } else {
      const assignable = new Set(assignableRoleIds);
      if (!assignable.has(submittedRbacRoleId)) {
        return json(
          { errors: { body: "You can't invite someone with this role on your current plan" } },
          { status: 400 }
        );
      }
      if (
        !isStrictlyBelow(
          systemRoles,
          inviterRole?.id ?? null,
          submittedRbacRoleId
        )
      ) {
        return json(
          { errors: { body: "You can only invite members at or below your own role" } },
          { status: 403 }
        );
      }
      resolvedRbacRoleId = submittedRbacRoleId;
    }
  }

  try {
    const invites = await inviteMembers({
      slug: organizationSlug,
      emails: submission.value.emails,
      userId,
      rbacRoleId: resolvedRbacRoleId,
    });

    for (const invite of invites) {
      try {
        await scheduleEmail({
          email: "invite",
          to: invite.email,
          orgName: invite.organization.title,
          inviterName: invite.inviter.name ?? undefined,
          inviterEmail: invite.inviter.email,
          inviteLink: `${env.LOGIN_ORIGIN}${acceptInvitePath(invite.token)}`,
        });
      } catch (error) {
        console.error("Failed to send invite email");
        console.error(error);
      }
    }

    return redirectWithSuccessMessage(
      organizationTeamPath(invites[0].organization),
      request,
      simplur`${submission.value.emails.length} member[|s] invited`
    );
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export default function Page() {
  const {
    limits,
    canPurchaseSeats,
    seatPricing,
    extraSeats,
    maxSeatQuota,
    planSeatLimit,
    roles,
    offerableRoleIds,
  } = useTypedLoaderData<typeof loader>();
  const [total, setTotal] = useState(limits.used);
  const organization = useOrganization();
  const lastSubmission = useActionData();

  // The loader filtered the catalogue to roles this inviter can
  // actually assign (plan tier × strict-below-my-level). With no plugin
  // installed, offerableRoleIds is [] and the picker hides entirely.
  const offerableSet = new Set(offerableRoleIds);
  const offerable = roles.filter((r) => offerableSet.has(r.id));
  const showRolePicker = offerable.length > 0;

  // Default to the lowest-tier offered role (the loader returns roles
  // in its allRoles order, which the plugin emits Owner→Member; the
  // last entry is the most restrictive).
  const defaultRoleId = showRolePicker
    ? offerable[offerable.length - 1].id
    : NO_RBAC_ROLE;
  const [selectedRoleId, setSelectedRoleId] = useState(defaultRoleId);

  const [form, { emails }] = useForm({
    id: "invite-members",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    defaultValue: {
      emails: [""],
    },
  });

  const fieldValues = useRef<string[]>([""]);
  const emailFields = useFieldList(form.ref, emails);

  return (
    <MainCenteredContainer className="max-w-[26rem] rounded-lg border border-grid-bright bg-background-dimmed p-5 shadow-lg">
      <div>
        <FormTitle
          LeadingIcon={<UserPlusIcon className="size-6 text-indigo-500" />}
          title="Invite team members"
          description={`Invite new team members to ${organization.title}.`}
        />
        {total > limits.limit &&
          (canPurchaseSeats && seatPricing ? (
            <InfoPanel
              variant="upgrade"
              icon={LockOpenIcon}
              iconClassName="text-indigo-500"
              title="Need more seats?"
              accessory={
                <PurchaseSeatsModal
                  seatPricing={seatPricing}
                  extraSeats={extraSeats}
                  usedSeats={limits.used}
                  maxQuota={maxSeatQuota}
                  planSeatLimit={planSeatLimit}
                  triggerButton={<Button variant="primary/small">Purchase more seats…</Button>}
                />
              }
              panelClassName="mb-4"
            >
              <Paragraph variant="small">
                You've used all {limits.limit} of your available team members. Purchase extra seats
                to add more.
              </Paragraph>
            </InfoPanel>
          ) : (
            <InfoPanel
              variant="upgrade"
              icon={LockOpenIcon}
              iconClassName="text-indigo-500"
              title="Unlock more team members"
              accessory={
                <LinkButton
                  to={v3BillingPath(organization)}
                  variant="secondary/small"
                  LeadingIcon={ArrowUpCircleIcon}
                  leadingIconClassName="text-indigo-500"
                >
                  Upgrade
                </LinkButton>
              }
              panelClassName="mb-4"
            >
              <Paragraph variant="small">
                You've used all {limits.limit} of your available team members. Upgrade your plan to
                add more.
              </Paragraph>
            </InfoPanel>
          ))}
        <Form method="post" {...form.props}>
          <Fieldset>
            <InputGroup>
              <Label htmlFor={emails.id}>Email addresses</Label>
              {emailFields.map((email, index) => (
                <Fragment key={email.key}>
                  <Input
                    {...conform.input(email, { type: "email" })}
                    placeholder={index === 0 ? "Enter an email address" : "Add another email"}
                    icon={EnvelopeIcon}
                    autoFocus={index === 0}
                    onChange={(e) => {
                      fieldValues.current[index] = e.target.value;
                      const filledFields = fieldValues.current.filter((v) => v !== "");
                      setTotal(limits.used + filledFields.length);
                      if (
                        emailFields.length === fieldValues.current.length &&
                        fieldValues.current.every((v) => v !== "")
                      ) {
                        requestIntent(form.ref.current ?? undefined, list.append(emails.name));
                      }
                    }}
                  />
                  <FormError id={email.errorId}>{email.error}</FormError>
                </Fragment>
              ))}
            </InputGroup>
            {showRolePicker ? (
              <InputGroup>
                <Label htmlFor="rbacRoleId">Role</Label>
                <input type="hidden" name="rbacRoleId" value={selectedRoleId} />
                <Select<string, (typeof offerable)[number]>
                  defaultValue={defaultRoleId}
                  items={offerable}
                  variant="tertiary/medium"
                  dropdownIcon
                  text={(v) =>
                    offerable.find((r) => r.id === v)?.name ?? "Pick a role"
                  }
                  setValue={(next) => {
                    if (typeof next === "string") setSelectedRoleId(next);
                  }}
                >
                  {(items) =>
                    items.map((role) => (
                      <SelectItem key={role.id} value={role.id}>
                        {role.name}
                      </SelectItem>
                    ))
                  }
                </Select>
                <Paragraph variant="extra-small" className="text-text-dimmed">
                  Invitees join with this role. They can be promoted later
                  from the Team page.
                </Paragraph>
              </InputGroup>
            ) : null}
            <FormButtons
              confirmButton={
                <Button type="submit" variant={"primary/small"} disabled={total > limits.limit}>
                  Send invitations
                </Button>
              }
              cancelButton={
                <LinkButton to={organizationTeamPath(organization)} variant={"secondary/small"}>
                  Cancel
                </LinkButton>
              }
            />
          </Fieldset>
        </Form>
      </div>
    </MainCenteredContainer>
  );
}
