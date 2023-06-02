import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ActionFunction, json } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { useTypedLoaderData } from "remix-typedjson";
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
import { useUser } from "~/hooks/useUser";
import { requireUserId } from "~/services/session.server";

const schema = z.object({
  name: z.string(),
  email: z.string().email(),
});

export const action: ActionFunction = async ({ request }) => {
  const userId = await requireUserId(request);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value) {
    return json(submission);
  }

  try {
    //todo
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export default function Page() {
  const user = useUser();
  const lastSubmission = useActionData();

  const [form, { name, email }] = useForm({
    id: "confirm-basic-details",
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
          <Form method="post" {...form.props}>
            <FormTitle title="Welcome to Trigger.dev" LeadingIcon="user" />
            <Fieldset>
              <InputGroup>
                <Label htmlFor={name.id}>Full name</Label>
                <Input
                  {...conform.input(name, { type: "text" })}
                  placeholder="Your full name"
                />
                <Hint>
                  Your team will see this name and we'll use it if we contact
                  you.
                </Hint>
                {/* <FormError id={} /> */}
              </InputGroup>
              <FormButtons confirmButton={undefined} />
            </Fieldset>
          </Form>
        </div>
      </MainCenteredContainer>
    </AppContainer>
  );
}
