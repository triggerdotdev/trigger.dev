import { conform, useFieldList, useForm, list, requestIntent } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import type { ActionFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { Fragment, useRef } from "react";
import simplur from "simplur";
import invariant from "tiny-invariant";
import { z } from "zod";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { env } from "~/env.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { inviteMembers } from "~/models/member.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { scheduleEmail } from "~/services/email.server";
import { requireUserId } from "~/services/session.server";
import { acceptInvitePath, organizationTeamPath } from "~/utils/pathBuilder";

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

  try {
    const invites = await inviteMembers({
      slug: organizationSlug,
      emails: submission.value.emails,
      userId,
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
  const organization = useOrganization();
  const lastSubmission = useActionData();

  const [form, { emails }] = useForm({
    id: "invite-members",
    lastSubmission,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  const fieldValues = useRef<string[]>([""]);
  const emailFields = useFieldList(form.ref, emails);

  return (
    <MainCenteredContainer>
      <div>
        <FormTitle
          LeadingIcon="invite-member"
          title="Invite team members"
          description={`Invite a new team member to ${organization.title}.`}
        />
        <Form method="post" {...form.props}>
          <Fieldset>
            <InputGroup>
              <Label htmlFor={emails.id}>Email addresses</Label>
              {emailFields.map((email, index) => (
                <Fragment key={email.key}>
                  <Input
                    {...conform.input(email, { type: "email" })}
                    placeholder={index === 0 ? "Enter an email address" : "Add another email"}
                    icon="envelope"
                    onChange={(e) => {
                      fieldValues.current[index] = e.target.value;
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
            <FormButtons
              confirmButton={
                <Button type="submit" variant={"primary/small"}>
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
