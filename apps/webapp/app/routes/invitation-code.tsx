import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { Form, useActionData } from "@remix-run/react";
import { ActionArgs, json } from "@remix-run/server-runtime";
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
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { TextLink } from "~/components/primitives/Paragraph";
import { prisma } from "~/db.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { grantUserCloudAccess } from "~/models/user.server";
import { requireUserId } from "~/services/session.server";
import { organizationsPath } from "~/utils/pathBuilder";

function createSchema(
  constraints: {
    isValidCode?: (code: string) => Promise<boolean>;
  } = {}
) {
  return z.object({
    code: z
      .string()
      .min(1, "Invite code missing")
      .superRefine((code, ctx) => {
        if (constraints.isValidCode === undefined) {
          //client-side validation skips this
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: conform.VALIDATION_UNDEFINED,
          });
        } else {
          // Tell zod this is an async validation by returning the promise
          return constraints.isValidCode(code).then((isValid) => {
            if (isValid) {
              return;
            }

            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Invalid invitation code",
            });
          });
        }
      }),
  });
}

export async function action({ request }: ActionArgs) {
  const userId = await requireUserId(request);
  const formData = await request.formData();

  const formSchema = createSchema({
    isValidCode: async (code) => {
      const invitationCode = await prisma.invitationCode.findUnique({
        where: {
          code,
        },
      });

      return invitationCode !== undefined && invitationCode !== null;
    },
  });

  const submission = await parse(formData, { schema: formSchema, async: true });

  if (!submission.value) {
    return json(submission);
  }

  try {
    await grantUserCloudAccess({
      id: userId,
      inviteCode: submission.value.code,
    });

    return redirectWithSuccessMessage(
      organizationsPath(),
      request,
      "🚀 Welcome to the Trigger.dev Cloud private beta"
    );
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
}

export default function Page() {
  const lastSubmission = useActionData();

  const [form, { code }] = useForm({
    id: "invitation-code",
    lastSubmission,
    shouldRevalidate: "onSubmit",
    onValidate({ formData }) {
      return parse(formData, { schema: createSchema() });
    },
  });

  return (
    <AppContainer showBackgroundGradient={true}>
      <NavBar />
      <MainCenteredContainer>
        <FormTitle
          LeadingIcon="qr-code"
          title="Trigger.dev Cloud Beta"
          description={
            <>
              Enter your code to get access. If you don't have one you can
              always{" "}
              <TextLink
                target="_blank"
                href="https://trigger.dev/docs/documentation/guides/self-hosting"
                trailingIcon="external-link"
                trailingIconClassName="h-3 w-3 text-indigo-500 transition group-hover:text-indigo-400"
              >
                self-host
              </TextLink>{" "}
              Trigger.dev
            </>
          }
        />
        <Form method="post" {...form.props}>
          <Fieldset>
            <InputGroup>
              <Input
                {...conform.input(code, { type: "text" })}
                placeholder="Your super secret invite code"
                icon="qr-code"
                autoFocus={Boolean(code.initialError)}
                spellCheck={false}
              />
              <FormError id={code.errorId}>{code.error}</FormError>
            </InputGroup>

            <FormButtons
              confirmButton={
                <Button
                  type="submit"
                  variant={"primary/small"}
                  TrailingIcon={"arrow-right"}
                >
                  Get access
                </Button>
              }
            />
          </Fieldset>
        </Form>
      </MainCenteredContainer>
    </AppContainer>
  );
}
