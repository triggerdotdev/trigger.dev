import { getFormProps, getInputProps, useForm } from "@conform-to/react";
import { conformZodMessage, parseWithZod } from "@conform-to/zod";
import { Form, type MetaFunction, useActionData } from "@remix-run/react";
import { type ActionFunction, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { UserProfilePhoto } from "~/components/UserProfilePhoto";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Switch } from "~/components/primitives/Switch";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { prisma } from "~/db.server";
import { useUser } from "~/hooks/useUser";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { updateUser } from "~/models/user.server";
import { requireUserId } from "~/services/session.server";
import { emailSchema, MAX_EMAIL_LENGTH } from "~/utils/emailValidation";
import { accountPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Your profile | Trigger.dev`,
    },
  ];
};

function createSchema(
  constraints: {
    isEmailUnique?: (email: string) => Promise<boolean>;
  } = {}
) {
  return z.object({
    name: z
      .string({ required_error: "You must enter a name" })
      .min(2, "Your name must be at least 2 characters long")
      .max(50),
    email: emailSchema.pipe(
      z.string().superRefine((email, ctx) => {
        if (constraints.isEmailUnique === undefined) {
          //client-side validation skips this
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: conformZodMessage.VALIDATION_UNDEFINED,
          });
        } else {
          // Tell zod this is an async validation by returning the promise
          return constraints.isEmailUnique(email).then((isUnique) => {
            if (isUnique) {
              return;
            }

            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Email is already being used by a different account",
            });
          });
        }
      })
    ),
    marketingEmails: z.preprocess((value) => value === "on", z.boolean()),
  });
}

export const action: ActionFunction = async ({ request }) => {
  const userId = await requireUserId(request);

  const formData = await request.formData();

  const formSchema = createSchema({
    isEmailUnique: async (email) => {
      const existingUser = await prisma.user.findFirst({
        where: {
          email,
        },
      });

      if (!existingUser) {
        return true;
      }

      if (existingUser.id === userId) {
        return true;
      }

      return false;
    },
  });

  const submission = await parseWithZod(formData, { schema: formSchema, async: true });

  if (submission.status !== "success") {
    return json(submission.reply());
  }

  try {
    const _user = await updateUser({
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
    // TODO: type this
    lastResult: lastSubmission as any,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: createSchema() });
    },
  });

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Your profile" />
      </NavBar>

      <PageBody>
        <MainHorizontallyCenteredContainer className="max-w-[37.5rem] overflow-visible">
          <div className="w-full border-b border-grid-dimmed pb-3">
            <Header2>Profile</Header2>
          </div>
          <Form method="post" {...getFormProps(form)} className="w-full">
            <div className="flex min-h-16 w-full items-center border-b border-grid-dimmed">
              <div className="flex w-full items-center justify-between gap-4">
                <InputGroup className="flex-1">
                  <Label>Profile picture</Label>
                </InputGroup>
                <div className="flex flex-none items-center">
                  <UserProfilePhoto className="size-8" strokeWidth={1.5} />
                </div>
              </div>
            </div>
            <div className="flex min-h-16 w-full items-center border-b border-grid-dimmed">
              <div className="flex w-full items-center justify-between gap-4">
                <InputGroup className="flex-1">
                  <Label htmlFor={name.id}>Full name</Label>
                </InputGroup>
                <div className="flex w-56 flex-none flex-col gap-1">
                  <Input
                    {...getInputProps(name, { type: "text" })}
                    placeholder="Your full name"
                    defaultValue={user?.name ?? ""}
                  />
                  <FormError id={name.errorId}>{name.errors}</FormError>
                </div>
              </div>
            </div>
            <div className="flex min-h-16 w-full items-center border-b border-grid-dimmed">
              <div className="flex w-full items-center justify-between gap-4">
                <InputGroup className="flex-1">
                  <Label htmlFor={email.id}>Email address</Label>
                </InputGroup>
                <div className="flex w-56 flex-none flex-col gap-1">
                  <Input
                    {...getInputProps(email, { type: "text" })}
                    maxLength={MAX_EMAIL_LENGTH}
                    placeholder="Your email"
                    defaultValue={user?.email ?? ""}
                  />
                  <FormError id={email.errorId}>{email.errors}</FormError>
                </div>
              </div>
            </div>
            <div className="flex min-h-16 w-full items-center border-b border-grid-dimmed">
              <div className="flex w-full items-center justify-between gap-4">
                <InputGroup className="flex-1">
                  <Label htmlFor={marketingEmails.id}>Receive onboarding emails</Label>
                </InputGroup>
                <div className="flex flex-none items-center">
                  <Switch
                    id={marketingEmails.id}
                    name={marketingEmails.name}
                    variant="medium"
                    defaultChecked={user.marketingEmails}
                    className="w-fit pr-3"
                  />
                </div>
              </div>
            </div>
            <div className="flex w-full justify-end pt-4">
              <Button type="submit" variant="primary/small">
                Update
              </Button>
            </div>
          </Form>
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
