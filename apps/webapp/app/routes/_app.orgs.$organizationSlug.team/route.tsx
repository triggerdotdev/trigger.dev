import { ActionFunction, LoaderArgs, json } from "@remix-run/server-runtime";
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
  AlertAction,
  AlertCancel,
  AlertContent,
  AlertDescription,
  AlertFooter,
  AlertHeader,
  AlertTitle,
  AlertTrigger,
} from "~/components/primitives/Alert";
import { Button, ButtonContent } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useOrganization } from "~/hooks/useOrganizations";
import { useUser } from "~/hooks/useUser";
import {
  getOrganizationTeamMembers,
  removeTeamMember,
} from "~/models/organization.server";
import { requireUserId } from "~/services/session.server";
import { titleCase } from "~/utils";
import { OrgAdminHeader } from "../_app.orgs.$organizationSlug._index/OrgAdminHeader";
import { parse } from "@conform-to/zod";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { organizationTeamPath } from "~/utils/pathBuilder";
import { Form, useActionData } from "@remix-run/react";
import { conform, useForm } from "@conform-to/react";

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug not found");

  const members = await getOrganizationTeamMembers({
    userId,
    slug: organizationSlug,
  });

  if (members === null) {
    throw new Response("Not Found", { status: 404 });
  }

  return typedjson({
    members,
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

export default function Page() {
  const user = useUser();
  const { members } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();

  return (
    <PageContainer>
      <OrgAdminHeader />
      <PageBody>
        <ul className="flex w-full max-w-md flex-col gap-2 divide-x divide-slate-850">
          {members.map((member) => (
            <li key={member.user.id} className="flex items-center gap-4">
              <UserAvatar
                avatarUrl={member.user.avatarUrl}
                name={member.user.name}
                className="h-10 w-10"
              />
              <div className="flex flex-col gap-0.5">
                <Header3>{member.user.name}</Header3>
                <Paragraph variant="small">{member.user.email}</Paragraph>
              </div>
              <div className="flex grow items-center justify-end gap-4">
                <Paragraph variant="small">
                  {titleCase(member.role.toLocaleLowerCase())}
                </Paragraph>
                <LeaveRemoveButton
                  userId={user.id}
                  member={member}
                  memberCount={members.length}
                />
              </div>
            </li>
          ))}
        </ul>
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
  const lastSubmission = useActionData();

  const [form, { memberId }] = useForm({
    id: "remove-member",
    lastSubmission,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  if (userId === member.user.id) {
    if (memberCount !== 1) {
      return (
        <SimpleTooltip
          button={
            <ButtonContent variant="secondary/small">Leave team</ButtonContent>
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
  const lastSubmission = useActionData();

  const [form, { memberId }] = useForm({
    id: "remove-member",
    lastSubmission,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  return (
    <Form method="post" {...form.props}>
      <input
        type="hidden"
        value={member.id}
        {...conform.input(memberId, { type: "hidden" })}
      />
      <Alert>
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
            <Button type="submit" variant="danger/small" form={form.props.id}>
              {actionText}
            </Button>
          </AlertFooter>
        </AlertContent>
      </Alert>
    </Form>
  );
}
