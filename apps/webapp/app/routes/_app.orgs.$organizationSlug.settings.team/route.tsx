import { useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { EnvelopeIcon, LockOpenIcon, TrashIcon, UserPlusIcon } from "@heroicons/react/20/solid";
import { Form, type MetaFunction } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useState } from "react";
import {
  type UseDataFunctionReturn,
  typedjson,
  useTypedActionData,
  useTypedLoaderData,
} from "remix-typedjson";
import invariant from "tiny-invariant";
import { z } from "zod";
import { UserAvatar } from "~/components/UserProfilePhoto";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
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
import { Header2, Header3 } from "~/components/primitives/Headers";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { $replica } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useUser } from "~/hooks/useUser";
import { removeTeamMember } from "~/models/member.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { TeamPresenter } from "~/presenters/TeamPresenter.server";
import { requireUserId } from "~/services/session.server";
import {
  inviteTeamMemberPath,
  organizationTeamPath,
  resendInvitePath,
  revokeInvitePath,
  v3BillingPath,
} from "~/utils/pathBuilder";
import { isSubmissionResult } from "~/utils/conformTo";

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

  return typedjson(result);
};

const schema = z.object({
  memberId: z.string(),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug not found");

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return typedjson(submission);
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
    return typedjson({ errors: { body: error.message } }, { status: 400 });
  }
};

type Member = UseDataFunctionReturn<typeof loader>["members"][number];
type Invite = UseDataFunctionReturn<typeof loader>["invites"][number];

export default function Page() {
  const { members, invites, limits } = useTypedLoaderData<typeof loader>();
  const user = useUser();
  const organization = useOrganization();

  const requiresUpgrade = limits.used >= limits.limit;

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
        </PageAccessories>
      </NavBar>
      <PageBody>
        <MainHorizontallyCenteredContainer>
          <Header2>
            Members{" "}
            <span className="font-normal text-text-dimmed">
              ({limits.used}/{limits.limit})
            </span>
          </Header2>
          <ul className="divide-ui-border mt-3 flex w-full flex-col divide-y border-y border-grid-bright">
            {members.map((member) => (
              <li key={member.user.id} className="flex items-center gap-x-4 py-4">
                <UserAvatar
                  avatarUrl={member.user.avatarUrl}
                  name={member.user.name}
                  className="size-10"
                />
                <div className="flex flex-col gap-0.5">
                  <Header3>
                    {member.user.name}{" "}
                    {member.user.id === user.id && <span className="text-text-dimmed">(You)</span>}
                  </Header3>
                  <Paragraph variant="small">{member.user.email}</Paragraph>
                </div>
                <div className="flex grow items-center justify-end gap-4">
                  <LeaveRemoveButton
                    userId={user.id}
                    member={member}
                    memberCount={members.length}
                  />
                </div>
              </li>
            ))}
          </ul>

          {invites.length > 0 && (
            <>
              <Header2 className="mb-3 mt-4">Pending invites</Header2>
              <ul className="flex w-full flex-col divide-y divide-charcoal-800 border-b border-grid-bright">
                {invites.map((invite) => (
                  <li key={invite.id} className="flex items-center gap-4 py-4">
                    <div className="rounded-md border border-charcoal-750 bg-charcoal-800 p-1.5">
                      <EnvelopeIcon className="size-7 text-cyan-500" />
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

          {requiresUpgrade ? (
            <InfoPanel
              variant="upgrade"
              icon={LockOpenIcon}
              iconClassName="text-indigo-500"
              title="Unlock more team members"
              accessory={
                <LinkButton to={v3BillingPath(organization)} variant="secondary/small">
                  Upgrade
                </LinkButton>
              }
              panelClassName="mt-4"
            >
              <Paragraph variant="small">
                You've used all {limits.limit} of your available team members. Upgrade your plan to
                enable more.
              </Paragraph>
            </InfoPanel>
          ) : (
            <div className="mt-4 flex justify-end">
              <LinkButton
                to={inviteTeamMemberPath(organization)}
                variant={"secondary/small"}
                LeadingIcon={UserPlusIcon}
              >
                Invite a team member
              </LinkButton>
            </div>
          )}
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}

function LeaveRemoveButton({
  userId,
  member,
  memberCount,
}: {
  userId: string;
  member: Member;
  memberCount: number;
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
          content="An organization requires at least 1 team member"
        />
      );
    }

    //you leave the team
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

  //you remove another member
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
  const _lastSubmission = useTypedActionData<typeof action>();
  const lastSubmission = isSubmissionResult(_lastSubmission) ? _lastSubmission : undefined;

  const [form, { memberId }] = useForm({
    id: "remove-member",
    lastSubmission,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  return (
    <Alert open={open} onOpenChange={(o) => setOpen(o)}>
      <AlertTrigger asChild>
        <Button variant="tertiary/small">{buttonText}</Button>
      </AlertTrigger>
      <AlertContent>
        <AlertHeader>
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>{description}</AlertDescription>
        </AlertHeader>
        <AlertFooter>
          <AlertCancel asChild>
            <Button variant="tertiary/small">Cancel</Button>
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

function ResendButton({ invite }: { invite: Invite }) {
  return (
    <Form method="post" action={resendInvitePath()} className="flex">
      <input type="hidden" value={invite.id} name="inviteId" />
      <Button type="submit" variant="tertiary/small">
        Resend invite
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
      <Button
        type="submit"
        variant="danger/small"
        LeadingIcon={TrashIcon}
        leadingIconClassName="text-white"
      />
    </Form>
  );
}
