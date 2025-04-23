import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ActionFunction, LoaderFunctionArgs, json, redirect } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import simplur from "simplur";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Paragraph } from "~/components/primitives/Paragraph";
import { acceptInvite, declineInvite, getUsersInvites } from "~/models/member.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { requireUser, requireUserId } from "~/services/session.server";
import { invitesPath, rootPath } from "~/utils/pathBuilder";
import { EnvelopeIcon } from "@heroicons/react/20/solid";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  //if there are no invites left we should redirect to the orgs page
  const invites = await getUsersInvites({ email: user.email });
  if (invites.length === 0) {
    throw redirect(rootPath());
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
        return redirectWithSuccessMessage(rootPath(), request, `You joined ${organization.title}`);
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
          rootPath(),
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
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  return (
    <AppContainer>
      <MainCenteredContainer>
        <div>
          <FormTitle
            LeadingIcon={<EnvelopeIcon className="size-6 text-cyan-500" />}
            className="mb-0 text-sky-500"
            title={simplur`You have ${invites.length} new invitation[|s]`}
          />
          {invites.map((invite) => (
            <Form key={invite.id} method="post" {...form.props}>
              <Fieldset>
                <InputGroup className="flex items-center justify-between border-b border-charcoal-800 py-4">
                  <div className="flex flex-col gap-y-0.5 overflow-hidden">
                    <Header2 className="truncate">{invite.organization.title}</Header2>
                    <Paragraph variant="small" className="truncate">
                      Invited by {invite.inviter.displayName ?? invite.inviter.email}
                    </Paragraph>
                    <input name="inviteId" type="hidden" value={invite.id} />
                  </div>
                  <div className="flex flex-col gap-y-1">
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
                  </div>
                </InputGroup>
              </Fieldset>
            </Form>
          ))}
        </div>
      </MainCenteredContainer>
    </AppContainer>
  );
}
