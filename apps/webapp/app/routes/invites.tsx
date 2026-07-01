import { getFormProps,useForm } from "@conform-to/react";
import { parseWithZod } from "@conform-to/zod";
import { EnvelopeIcon } from "@heroicons/react/20/solid";
import { type ActionFunction,type LoaderFunctionArgs,json,redirect } from "@remix-run/node";
import { Form,useActionData } from "@remix-run/react";
import { typedjson,useTypedLoaderData } from "remix-typedjson";
import simplur from "simplur";
import { z } from "zod";
import { BackgroundWrapper } from "~/components/BackgroundWrapper";
import { AppContainer,MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormError } from "~/components/primitives/FormError";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Header2 } from "~/components/primitives/Headers";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
acceptInvite,
declineInvite,
ENV_SETUP_INCOMPLETE,
getUsersInvites,
isAcceptInviteFormError,
} from "~/models/member.server";
import { redirectWithErrorMessage,redirectWithSuccessMessage } from "~/models/message.server";
import { requireUser } from "~/services/session.server";
import { invitesPath,rootPath } from "~/utils/pathBuilder";

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
  organizationId: z.string().optional(),
});

export const action: ActionFunction = async ({ request }) => {
  const user = await requireUser(request);

  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema });

  if (submission.status !== "success") {
    return json(submission.reply());
  }

  const intent = formData.get("intent");

  try {
    if (intent === "accept") {
      const { remainingInvites, organization } = await acceptInvite({
        inviteId: submission.value.inviteId,
        organizationId: submission.value.organizationId,
        user: { id: user.id, email: user.email },
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
    } else if (intent === "decline") {
      const { remainingInvites, organization } = await declineInvite({
        inviteId: submission.value.inviteId,
        user: { id: user.id, email: user.email },
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
  } catch (error) {
    if (isAcceptInviteFormError(error)) {
      // Membership may already exist while the invite is still present if env
      // provisioning failed. With no invites left, the loader would redirect
      // and discard a 400 FormError — send the user to orgs with a toast instead.
      if (error.message === ENV_SETUP_INCOMPLETE) {
        const remainingInvites = await getUsersInvites({ email: user.email });
        if (remainingInvites.length === 0) {
          return redirectWithErrorMessage(rootPath(), request, error.message, {
            ephemeral: false,
          });
        }
      }

      return json(
        {
          intent: intent,
          payload: submission.payload,
          error: { "": [error.message] },
        },
        { status: 400 }
      );
    }
    throw error;
  }
};

export default function Page() {
  const { invites } = useTypedLoaderData<typeof loader>();
  const lastSubmission = useActionData();

  const [form, fields] = useForm({
    id: "accept-invite",
    // TODO: type this
    lastResult: lastSubmission as any,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema });
    },
  });

  return (
    <AppContainer className="bg-charcoal-900">
      <BackgroundWrapper>
        <MainCenteredContainer
          variant="onboarding"
          className="max-w-[26rem] rounded-lg border border-grid-bright bg-background-dimmed p-5 shadow-lg"
        >
          <div>
            <FormTitle
              LeadingIcon={<EnvelopeIcon className="size-6 text-cyan-500" />}
              className="mb-0 text-sky-500"
              title={simplur`You have ${invites.length} new invitation[|s]`}
            />
            <FormError>{form.errors}</FormError>
            {invites.map((invite) => (
              <Form key={invite.id} method="post" {...getFormProps(form)}>
                <Fieldset>
                  <InputGroup className="flex items-center justify-between border-b border-charcoal-800 py-4">
                    <div className="flex flex-col gap-y-0.5 overflow-hidden">
                      <Header2 className="truncate">{invite.organization.title}</Header2>
                      <Paragraph variant="small" className="truncate">
                        Invited by {invite.inviter.displayName ?? invite.inviter.email}
                      </Paragraph>
                      <input name="inviteId" type="hidden" value={invite.id} />
                      <input name="organizationId" type="hidden" value={invite.organizationId} />
                    </div>
                    <div className="flex flex-col gap-y-1">
                      <Button type="submit" name="intent" value="accept" variant={"primary/small"}>
                        Accept
                      </Button>
                      <Button
                        type="submit"
                        name="intent"
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
      </BackgroundWrapper>
    </AppContainer>
  );
}
