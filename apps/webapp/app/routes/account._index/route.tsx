import { getFormProps, getInputProps, useForm } from "@conform-to/react";
import { conformZodMessage, parseWithZod } from "@conform-to/zod";
import { MoonIcon, SunIcon } from "@heroicons/react/20/solid";
import {
  Form,
  type MetaFunction,
  useActionData,
  useFetcher,
  useLoaderData,
} from "@remix-run/react";
import { type ActionFunction, json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { AvatarCircleIcon } from "~/assets/icons/AvatarCircleIcon";
import { EnvelopeIcon } from "~/assets/icons/EnvelopeIcon";
import { UserProfilePhoto } from "~/components/UserProfilePhoto";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { prisma } from "~/db.server";
import { useUser } from "~/hooks/useUser";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { updateUser } from "~/models/user.server";
import { updateThemePreference } from "~/services/dashboardPreferences.server";
import { flag } from "~/v3/featureFlags.server";
import { requireUser, requireUserId } from "~/services/session.server";
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
    email: z
      .string()
      .email()
      .superRefine((email, ctx) => {
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
      }),
    marketingEmails: z.preprocess((value) => value === "on", z.boolean()),
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireUserId(request);
  const showThemeSwitcher = await flag({ key: "hasThemeSwitcher", defaultValue: true });
  return json({ showThemeSwitcher });
}

export const action: ActionFunction = async ({ request }) => {
  const userId = await requireUserId(request);

  const formData = await request.formData();

  if (formData.get("action") === "update-theme") {
    const showThemeSwitcher = await flag({ key: "hasThemeSwitcher", defaultValue: true });
    if (!showThemeSwitcher) {
      return json({ error: "Not available" }, { status: 404 });
    }
    const user = await requireUser(request);
    const theme = formData.get("theme") === "light" ? "light" : "dark";
    await updateThemePreference({ user, theme });
    return json({ success: true });
  }

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
  const { showThemeSwitcher } = useLoaderData<typeof loader>();
  const lastSubmission = useActionData();
  const themeFetcher = useFetcher();
  const pendingTheme = themeFetcher.formData?.get("theme");
  const theme =
    typeof pendingTheme === "string"
      ? (pendingTheme as "dark" | "light")
      : (user.dashboardPreferences.theme ?? "dark");

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
        <MainHorizontallyCenteredContainer className="grid place-items-center">
          <div className="mb-3 w-full border-b border-grid-dimmed pb-3">
            <Header2>Profile</Header2>
          </div>
          <Form method="post" {...getFormProps(form)} className="w-full">
            <InputGroup className="mb-4">
              <Label htmlFor={name.id}>Profile picture</Label>
              <UserProfilePhoto className="size-24" />
            </InputGroup>
            <Fieldset>
              <InputGroup fullWidth>
                <Label htmlFor={name.id}>Full name</Label>
                <Input
                  {...getInputProps(name, { type: "text" })}
                  placeholder="Your full name"
                  defaultValue={user?.name ?? ""}
                  icon={AvatarCircleIcon}
                />
                <Hint>Your teammates will see this</Hint>
                <FormError id={name.errorId}>{name.errors}</FormError>
              </InputGroup>
              <InputGroup fullWidth>
                <Label htmlFor={email.id}>Email address</Label>
                <Input
                  {...getInputProps(email, { type: "text" })}
                  placeholder="Your email"
                  defaultValue={user?.email ?? ""}
                  icon={EnvelopeIcon}
                />
                <FormError id={email.errorId}>{email.errors}</FormError>
              </InputGroup>
              <InputGroup>
                <Label>Notifications</Label>
                <CheckboxWithLabel
                  {...getInputProps(marketingEmails, { type: "checkbox" })}
                  label="Receive onboarding emails"
                  variant="simple/small"
                  defaultChecked={user.marketingEmails}
                />
                <FormError id={marketingEmails.errorId}>{marketingEmails.errors}</FormError>
              </InputGroup>

              <FormButtons
                confirmButton={
                  <Button type="submit" variant={"secondary/small"}>
                    Update
                  </Button>
                }
              />
            </Fieldset>
          </Form>
          {showThemeSwitcher && (
            <>
              <div className="mb-3 mt-8 w-full border-b border-grid-dimmed pb-3">
                <Header2>Appearance</Header2>
              </div>
              <div className="flex w-full items-center justify-between gap-4">
                <Label>Interface theme</Label>
                <Select<"dark" | "light", "dark" | "light">
                  value={theme}
                  setValue={(value) =>
                    themeFetcher.submit(
                      { action: "update-theme", theme: value },
                      { method: "post" }
                    )
                  }
                  variant="secondary/small"
                  dropdownIcon
                  items={["dark", "light"]}
                  text={(value) => (
                    <span className="flex items-center gap-1.5">
                      {value === "dark" ? (
                        <span className="grid size-4 place-items-center">
                          <MoonIcon className="size-3 text-text-dimmed" />
                        </span>
                      ) : (
                        <SunIcon className="size-4 text-text-dimmed" />
                      )}
                      {value === "dark" ? "Dark" : "Light"}
                    </span>
                  )}
                  className="w-32"
                >
                  {(items) =>
                    items.map((item) => (
                      <SelectItem
                        key={item}
                        value={item}
                        icon={
                          item === "dark" ? (
                            <span className="grid size-4 place-items-center">
                              <MoonIcon className="size-3 text-text-dimmed" />
                            </span>
                          ) : (
                            <SunIcon className="size-4 text-text-dimmed" />
                          )
                        }
                      >
                        {item === "dark" ? "Dark" : "Light"}
                      </SelectItem>
                    ))
                  }
                </Select>
              </div>
            </>
          )}
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
