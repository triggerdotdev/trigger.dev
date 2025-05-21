import { conform, list, requestIntent, useFieldList, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { EnvelopeIcon, LockOpenIcon, UserPlusIcon } from "@heroicons/react/20/solid";
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
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { inviteMembers } from "~/models/member.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { TeamPresenter } from "~/presenters/TeamPresenter.server";
import { scheduleEmail } from "~/services/email.server";
import { requireUserId } from "~/services/session.server";
import { acceptInvitePath, organizationTeamPath, v3BillingPath } from "~/utils/pathBuilder";

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
  const { limits } = useTypedLoaderData<typeof loader>();
  const [total, setTotal] = useState(limits.used);
  const organization = useOrganization();
  const lastSubmission = useActionData();

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
    <MainCenteredContainer>
      <div>
        <FormTitle
          LeadingIcon={<UserPlusIcon className="size-6 text-indigo-500" />}
          title="Invite team members"
          description={`Invite new team members to ${organization.title}.`}
        />
        {total > limits.limit && (
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
            panelClassName="mb-4"
          >
            <Paragraph variant="small">
              You've used all {limits.limit} of your available team members. Upgrade your plan to
              add more.
            </Paragraph>
          </InfoPanel>
        )}
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
            <FormButtons
              confirmButton={
                <Button type="submit" variant={"primary/small"} disabled={total > limits.limit}>
                  Send invitations
                </Button>
              }
              cancelButton={
                <LinkButton to={organizationTeamPath(organization)} variant={"tertiary/small"}>
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
