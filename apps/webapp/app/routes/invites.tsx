import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ActionFunction, LoaderArgs, redirect } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Header3 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { acceptInvite, getUsersInvites } from "~/models/member.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { requireUser, requireUserId } from "~/services/session.server";
import { organizationPath, organizationsPath } from "~/utils/pathBuilder";

export const loader = async ({ request }: LoaderArgs) => {
  const user = await requireUser(request);

  //if there are no invites left we should redirect to the orgs page
  const invites = await getUsersInvites({ email: user.email });
  if (invites.length === 0) {
    throw redirect(organizationsPath());
  }

  return typedjson({ invites });
};

const schema = z.object({
  inviteId: z.string(),
});

export const action: ActionFunction = async ({ request }) => {
  const userId = await requireUserId(request);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value) {
    return json(submission);
  }

  try {
    if (submission.intent === "accept") {
      const organization = await acceptInvite({
        inviteId: submission.value.inviteId,
        userId,
      });
      return redirectWithSuccessMessage(
        organizationPath(organization),
        request,
        `You joined ${organization.title}`
      );
    } else if (submission.intent === "decline") {
      console.log("decline", submission.value.inviteId);
    }
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export default function Page() {
  const { invites } = useTypedLoaderData<typeof loader>();
  const lastSubmission = useActionData();

  const [form, { inviteId }] = useForm({
    id: "accept-invite",
    lastSubmission,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  return (
    <MainCenteredContainer>
      <div>
        <FormTitle
          LeadingIcon="envelope"
          title="You've been invited to join a team"
        />
        <Form method="post" {...form.props}>
          <Fieldset>
            {invites.map((invite) => (
              <InputGroup key={invite.id}>
                <Header3>{invite.organization.title}</Header3>
                <Paragraph>
                  Invited by{" "}
                  {invite.inviter.displayName ?? invite.inviter.email}
                </Paragraph>
                <input
                  {...conform.input(inviteId, { type: "hidden" })}
                  value={invite.id}
                />
                <Button
                  type="submit"
                  name={conform.INTENT}
                  value="accept"
                  variant={"primary/small"}
                >
                  Accept
                </Button>
                <Button
                  type="submit"
                  name={conform.INTENT}
                  value="decline"
                  variant={"secondary/small"}
                >
                  Decline
                </Button>
              </InputGroup>
            ))}
          </Fieldset>
        </Form>
      </div>
    </MainCenteredContainer>
  );
}
