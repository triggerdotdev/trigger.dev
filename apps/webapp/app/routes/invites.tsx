import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ActionFunction, LoaderArgs, redirect } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import {
  AppContainer,
  MainCenteredContainer,
} from "~/components/layout/AppLayout";
import { NavBar } from "~/components/navigation/NavBar";
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
import {
  acceptInvite,
  declineInvite,
  getUsersInvites,
} from "~/models/member.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { requireUser, requireUserId } from "~/services/session.server";
import {
  invitesPath,
  organizationPath,
  organizationsPath,
} from "~/utils/pathBuilder";

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
      const { remainingInvites, organization } = await acceptInvite({
        inviteId: submission.value.inviteId,
        userId,
      });

      if (remainingInvites.length === 0) {
        return redirectWithSuccessMessage(
          organizationsPath(),
          request,
          `You joined ${organization.title}`
        );
      } else {
        return redirectWithSuccessMessage(
          invitesPath(),
          request,
          `You joined ${organization.title}`
        );
      }
    } else if (submission.intent === "decline") {
      const { remainingInvites, organization } = await declineInvite({
        inviteId: submission.value.inviteId,
        userId,
      });
      if (remainingInvites.length === 0) {
        return redirectWithSuccessMessage(
          organizationsPath(),
          request,
          `You declined the invite for ${organization.title}`
        );
      } else {
        return redirectWithSuccessMessage(
          invitesPath(),
          request,
          `You declined the invite for ${organization.title}`
        );
      }
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
    <AppContainer showBackgroundGradient={true}>
      <NavBar />
      <MainCenteredContainer>
        <div>
          <FormTitle
            LeadingIcon="envelope"
            title="You've been invited to join a team"
          />
          {invites.map((invite) => (
            <Form key={invite.id} method="post" {...form.props}>
              <Fieldset>
                <InputGroup>
                  <Header3>{invite.organization.title}</Header3>
                  <Paragraph>
                    Invited by{" "}
                    {invite.inviter.displayName ?? invite.inviter.email}
                  </Paragraph>
                  <input name="inviteId" type="hidden" value={invite.id} />
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
              </Fieldset>
            </Form>
          ))}
        </div>
      </MainCenteredContainer>
    </AppContainer>
  );
}
