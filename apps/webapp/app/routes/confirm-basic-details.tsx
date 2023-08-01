import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { HandRaisedIcon } from "@heroicons/react/24/solid";
import { ActionFunction, json } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { motion } from "framer-motion";
import { forwardRef, useState } from "react";
import { z } from "zod";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { NavBar } from "~/components/navigation/NavBar";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { prisma } from "~/db.server";
import { useUser } from "~/hooks/useUser";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { updateUser } from "~/models/user.server";
import { requireUserId } from "~/services/session.server";
import { organizationsPath } from "~/utils/pathBuilder";

function createSchema(
  constraints: {
    isEmailUnique?: (email: string) => Promise<boolean>;
  } = {}
) {
  return z
    .object({
      name: z.string().min(3, "Your name must be at least 3 characters").max(50),
      email: z
        .string()
        .email()
        .superRefine((email, ctx) => {
          if (constraints.isEmailUnique === undefined) {
            //client-side validation skips this
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: conform.VALIDATION_UNDEFINED,
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
        }),
      confirmEmail: z.string(),
    })
    .refine((value) => value.email === value.confirmEmail, {
      message: "Emails must match",
      path: ["confirmEmail"],
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

  const submission = await parse(formData, { schema: formSchema, async: true });

  if (!submission.value) {
    return json(submission);
  }

  try {
    const updatedUser = await updateUser({
      id: userId,
      name: submission.value.name,
      email: submission.value.email,
    });

    return redirectWithSuccessMessage(
      organizationsPath(),
      request,
      "Your details have been updated."
    );
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

const HandIcon = forwardRef<HTMLDivElement, {}>(({}, ref) => {
  return (
    <div ref={ref}>
      <HandRaisedIcon className="h-7 w-7 text-amber-300" />
    </div>
  );
});
const MotionHand = motion(HandIcon);

export default function Page() {
  const user = useUser();
  const lastSubmission = useActionData();
  const [enteredEmail, setEnteredEmail] = useState<string>(user.email ?? "");

  const [form, { name, email, confirmEmail }] = useForm({
    id: "confirm-basic-details",
    lastSubmission,
    onValidate({ formData }) {
      return parse(formData, { schema: createSchema() });
    },
  });

  const shouldShowConfirm = user.email !== enteredEmail || user.email === "";

  return (
    <AppContainer showBackgroundGradient={true}>
      <NavBar />
      <MainCenteredContainer>
        <div>
          <Form method="post" {...form.props}>
            <FormTitle
              title="Welcome to Trigger.dev"
              LeadingIcon={
                <MotionHand
                  style={{
                    originY: 0.75,
                  }}
                  initial={{
                    rotate: 0,
                  }}
                  animate={{
                    rotate: [0, -20, 0, 20, 0, -20, 0, 20, 0],
                  }}
                  transition={{
                    delay: 1,
                    duration: 1,
                    repeatDelay: 5,
                    repeat: Infinity,
                    ease: "linear",
                  }}
                />
              }
              description="We just need you to confirm a couple of details, it'll only take a minute."
            />
            <Fieldset>
              <InputGroup>
                <Label htmlFor={name.id}>Full name</Label>
                <Input
                  {...conform.input(name, { type: "text" })}
                  defaultValue={user.name ?? ""}
                  placeholder="Your full name"
                  icon="user"
                  autoFocus={Boolean(name.initialError)}
                />
                <Hint>Your team will see this name and we'll use it if we contact you.</Hint>
                <FormError id={name.errorId}>{name.error}</FormError>
              </InputGroup>
              <InputGroup>
                <Label htmlFor={email.id}>Email</Label>
                <Input
                  {...conform.input(email, { type: "email" })}
                  defaultValue={enteredEmail}
                  onChange={(e) => {
                    setEnteredEmail(e.target.value);
                  }}
                  placeholder="Your email address"
                  icon="envelope"
                  autoFocus={Boolean(email.initialError)}
                  spellCheck={false}
                />
                {!shouldShowConfirm && (
                  <Hint>
                    Check this is the email you'd like associated with your Trigger.dev account.
                  </Hint>
                )}
                <FormError id={email.errorId}>{email.error}</FormError>
              </InputGroup>

              {shouldShowConfirm ? (
                <InputGroup>
                  <Label htmlFor={confirmEmail.id}>Confirm email</Label>
                  <Input
                    {...conform.input(confirmEmail, { type: "email" })}
                    placeholder="Your email, again"
                    icon="envelope"
                    spellCheck={false}
                  />
                  <Hint>
                    Check this is the email you'd like associated with your Trigger.dev account.
                  </Hint>
                  <FormError id={confirmEmail.errorId}>{confirmEmail.error}</FormError>
                </InputGroup>
              ) : (
                <>
                  <input {...conform.input(confirmEmail, { type: "hidden" })} value={user.email} />
                </>
              )}

              <FormButtons
                confirmButton={
                  <Button type="submit" variant={"primary/small"} TrailingIcon={"arrow-right"}>
                    Continue
                  </Button>
                }
              />
            </Fieldset>
          </Form>
        </div>
      </MainCenteredContainer>
    </AppContainer>
  );
}
