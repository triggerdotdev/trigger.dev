import { useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { EnvelopeIcon, UserPlusIcon } from "@heroicons/react/20/solid";
import { Form, useActionData } from "@remix-run/react";
import { ActionFunction, LoaderArgs, json } from "@remix-run/server-runtime";
import { useState } from "react";
import {
  UseDataFunctionReturn,
  typedjson,
  useTypedLoaderData,
} from "remix-typedjson";
import invariant from "tiny-invariant";
import { z } from "zod";
import { UserAvatar } from "~/components/UserProfilePhoto";
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
import {
  Button,
  ButtonContent,
  LinkButton,
} from "~/components/primitives/Buttons";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useOrganization } from "~/hooks/useOrganizations";
import { useUser } from "~/hooks/useUser";
import {
  getTeamMembersAndInvites,
  removeTeamMember,
} from "~/models/member.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { requireUserId } from "~/services/session.server";
import { formatDateTime, titleCase } from "~/utils";
import {
  inviteTeamMemberPath,
  organizationTeamPath,
  resendInvitePath,
} from "~/utils/pathBuilder";
import { OrgAdminHeader } from "../_app.orgs.$organizationSlug._index/OrgAdminHeader";
import { resendSchema } from "../invite-resend";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug not found");

  const result = await getTeamMembersAndInvites({
    userId,
    slug: organizationSlug,
  });

  if (result === null) {
    throw new Response("Not Found", { status: 404 });
  }

  return typedjson({
    members: result.members,
    invites: result.invites,
  });
};

const schema = z.object({
  memberId: z.string(),
});

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug not found");

  const formData = await request.formData();
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
      return redirectWithSuccessMessage(
        "/",
        request,
        `You left the organization`
      );
    }

    return redirectWithSuccessMessage(
      organizationTeamPath(deletedMember.organization),
      request,
      `Removed ${deletedMember.user.name ?? "member"} from team`
    );
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

type Member = UseDataFunctionReturn<typeof loader>["members"][number];
type Invite = UseDataFunctionReturn<typeof loader>["invites"][number];

export default function Page() {
  const user = useUser();
  const { members, invites } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();

  return (
    <PageContainer>
      <OrgAdminHeader />
      <PageBody>
        <Header2 className="mb-4">Members</Header2>
        <ul className="flex w-full max-w-md flex-col gap-4 divide-y divide-slate-800 border-b border-slate-800">
          {members.map((member) => (
            <li key={member.user.id} className="flex items-center gap-4 pb-4">
              <UserAvatar
                avatarUrl={member.user.avatarUrl}
                name={member.user.name}
                className="h-10 w-10"
              />
              <div className="flex flex-col gap-0.5">
                <Header3>
                  {member.user.name}{" "}
                  {member.user.id === user.id && (
                    <span className="text-dimmed">(You)</span>
                  )}
                </Header3>
                <Paragraph variant="small">{member.user.email}</Paragraph>
              </div>
              <div className="flex grow items-center justify-end gap-4">
                {/* 
                // This displays Member or Admin but we'll implement this when we implement roles properly
                <Paragraph variant="extra-small">
                  {titleCase(member.role.toLocaleLowerCase())}
                </Paragraph> */}
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
            <Header2 className="mt-4">Pending invites</Header2>
            <ul className="flex w-full max-w-md flex-col divide-y divide-slate-850 border-b border-slate-800">
              {invites.map((invite) => (
                <li key={invite.id} className="flex items-center gap-4 py-4">
                  <EnvelopeIcon className="h-10 w-10 text-slate-800" />
                  <div className="flex flex-col gap-0.5">
                    <Header3>{invite.email}</Header3>
                    <Paragraph variant="small">
                      Invite sent {formatDateTime(invite.updatedAt, "medium")}
                    </Paragraph>
                  </div>
                  <div className="flex grow items-center justify-end gap-4">
                    <ResendButton invite={invite} />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="mt-4 flex max-w-md justify-end">
          <LinkButton
            to={inviteTeamMemberPath(organization)}
            variant={"primary/small"}
            LeadingIcon={UserPlusIcon}
          >
            Invite a team member
          </LinkButton>
        </div>
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
            <ButtonContent
              variant="secondary/small"
              className="cursor-not-allowed"
            >
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
      title={`Are you sure you want to remove ${
        member.user.name ?? "them"
      } from the team?`}
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
  const lastSubmission = useActionData();

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
        <Button variant="secondary/small">{buttonText}</Button>
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
    <Form method="post" action={resendInvitePath()}>
      <input type="hidden" value={invite.id} name="inviteId" />
      <Button type="submit" variant="secondary/small">
        Resend invite
      </Button>
    </Form>
  );
}
