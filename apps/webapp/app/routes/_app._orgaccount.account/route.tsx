import { Form, useActionData } from "@remix-run/react";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { useUser } from "~/hooks/useUser";
import { z } from "zod";
import { ActionFunction, json, redirect } from "@remix-run/server-runtime";
import { requireUserId } from "~/services/session.server";
import { parse } from "@conform-to/zod";
import { accountPath } from "~/utils/pathBuilder";
import { conform, useForm } from "@conform-to/react";
import { UserProfilePhoto } from "~/components/UserProfilePhoto";
import { Checkbox } from "~/components/primitives/Checkbox";
import { updateUser } from "~/models/user.server";
import { redirectWithSuccessMessage } from "~/models/message.server";

const schema = z.object({
  name: z
    .string({ required_error: "You must enter a name" })
    .min(2, "Your name must be at least 2 characters long")
    .max(50),
  email: z.string().email(),
  marketingEmails: z.preprocess((value) => value === "on", z.boolean()),
});

export const action: ActionFunction = async ({ request }) => {
  const userId = await requireUserId(request);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  try {
    const user = await updateUser({
      id: userId,
      name: submission.value.name,
      email: submission.value.email,
      marketingEmails: submission.value.marketingEmails,
    });

    return redirectWithSuccessMessage(
      accountPath(),
      request,
      "Your account profile has been updated."
    );
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export default function Page() {
  const user = useUser();
  const lastSubmission = useActionData();

  const [form, { name, email, marketingEmails }] = useForm({
    id: "account",
    lastSubmission,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  return (
    <Form method="post" {...form.props} className="max-w-md">
      <InputGroup className="mb-4">
        <Label htmlFor={name.id}>Profile picture</Label>
        <UserProfilePhoto className="h-24 w-24" />
      </InputGroup>
      <Fieldset>
        <InputGroup>
          <Label htmlFor={name.id}>Full name</Label>
          <Input
            {...conform.input(name, { type: "text" })}
            placeholder="Your full name"
            defaultValue={user?.name ?? ""}
            icon="account"
          />
          <Hint>Your teammates will see this</Hint>
          <FormError id={name.errorId}>{name.error}</FormError>
        </InputGroup>
        <InputGroup>
          <Label htmlFor={email.id}>Email address</Label>
          <Input
            {...conform.input(email, { type: "text" })}
            placeholder="Your email"
            defaultValue={user?.email ?? ""}
            icon="envelope"
          />
          <FormError id={email.errorId}>{email.error}</FormError>
        </InputGroup>
        <InputGroup>
          <Label>Notifications</Label>
          <Checkbox
            id="marketingEmails"
            {...conform.input(marketingEmails, { type: "checkbox" })}
            label="Receive product updates"
            variant="simple/small"
            defaultChecked={user.marketingEmails}
          />
          <FormError id={marketingEmails.errorId}>
            {marketingEmails.error}
          </FormError>
        </InputGroup>

        <FormButtons
          confirmButton={
            <Button type="submit" variant={"primary/small"}>
              Update
            </Button>
          }
        />
      </Fieldset>
    </Form>
  );
}
