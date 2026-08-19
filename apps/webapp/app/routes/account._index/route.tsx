import { getFormProps, getInputProps, useForm } from "@conform-to/react";
import { useEffect, useState } from "react";
import { conformZodMessage, parseWithZod } from "@conform-to/zod";
import { ComputerDesktopIcon, MoonIcon, SunIcon, SwatchIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useFetcher, useLoaderData } from "@remix-run/react";
import { type ActionFunction, json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { UserProfilePhoto } from "~/components/UserProfilePhoto";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Slider } from "~/components/primitives/Slider";
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
import {
  updateContrastPreference,
  updateThemePreference,
} from "~/services/dashboardPreferences.server";
import {
  normalizeThemeContrast,
  normalizeThemePreference,
  type ThemePreference,
} from "~/utils/themePreference";
import { cachedFlag } from "~/v3/featureFlags.server";
import { requireUser, requireUserId } from "~/services/session.server";
import { emailSchema, MAX_EMAIL_LENGTH } from "~/utils/emailValidation";
import { accountPath } from "~/utils/pathBuilder";
import { pageMeta } from "~/utils/pageTitle";

const THEME_LABELS: Record<ThemePreference, string> = {
  classic: "Classic",
  system: "System preference",
  dark: "Dark",
  light: "Light",
};

function themeLabel(value: ThemePreference) {
  return THEME_LABELS[value];
}

function themeIcon(value: ThemePreference) {
  switch (value) {
    case "classic":
      return <SwatchIcon className="size-4 text-text-dimmed" />;
    case "system":
      return <ComputerDesktopIcon className="size-4 text-text-dimmed" />;
    case "dark":
      // Moon glyph reads small at its natural size, so nudge it up inside a
      // size-4 box to line up with the other icons.
      return (
        <span className="grid size-4 place-items-center">
          <MoonIcon className="size-3 text-text-dimmed" />
        </span>
      );
    case "light":
      return <SunIcon className="size-4 text-text-dimmed" />;
  }
}

function renderTheme(value: ThemePreference) {
  return (
    <span className="flex items-center gap-1.5">
      {themeIcon(value)}
      {themeLabel(value)}
    </span>
  );
}

export const meta = pageMeta("Your profile");

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

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const showThemeSwitcher =
    user.admin || (await cachedFlag({ key: "hasThemeSwitcher", defaultValue: false }));
  return json({ showThemeSwitcher });
}

export const action: ActionFunction = async ({ request }) => {
  const userId = await requireUserId(request);

  const formData = await request.formData();

  if (formData.get("action") === "update-theme") {
    const user = await requireUser(request);
    const showThemeSwitcher =
      user.admin || (await cachedFlag({ key: "hasThemeSwitcher", defaultValue: false }));
    if (!showThemeSwitcher) {
      return json({ error: "Not available" }, { status: 404 });
    }
    const theme = normalizeThemePreference(formData.get("theme"));
    await updateThemePreference({ user, theme });
    return json({ success: true });
  }

  if (formData.get("action") === "update-contrast") {
    const user = await requireUser(request);
    const showThemeSwitcher =
      user.admin || (await cachedFlag({ key: "hasThemeSwitcher", defaultValue: false }));
    if (!showThemeSwitcher) {
      return json({ error: "Not available" }, { status: 404 });
    }
    const contrast = normalizeThemeContrast(formData.get("contrast"));
    await updateContrastPreference({ user, contrast });
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
  const contrastFetcher = useFetcher();
  const pendingTheme = themeFetcher.formData?.get("theme");
  const pendingContrast = contrastFetcher.formData?.get("contrast");
  const contrast =
    typeof pendingContrast === "string"
      ? normalizeThemeContrast(pendingContrast)
      : normalizeThemeContrast(user.dashboardPreferences.contrast);
  const theme: ThemePreference =
    typeof pendingTheme === "string"
      ? normalizeThemePreference(pendingTheme)
      : normalizeThemePreference(user.dashboardPreferences.theme);

  // Dragging previews the contrast via the CSS var before it persists; once the
  // save settles, resnap the page and the thumb to the stored value so a failed
  // or rejected save doesn't leave a phantom contrast level on screen.
  const [contrastPreview, setContrastPreview] = useState(contrast);
  useEffect(() => {
    if (contrastFetcher.state === "idle") {
      setContrastPreview(contrast);
      document.documentElement.style.setProperty("--theme-contrast", String(contrast / 100));
    }
  }, [contrastFetcher.state, contrast]);

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
          {showThemeSwitcher && (
            <>
              <div className="mb-3 mt-8 w-full border-b border-grid-dimmed pb-3">
                <Header2>Appearance</Header2>
              </div>
              <div className="flex w-full items-center justify-between gap-4">
                <Label>Interface theme</Label>
                <Select<ThemePreference, ThemePreference>
                  aria-label="Interface theme"
                  value={theme}
                  setValue={(value) =>
                    themeFetcher.submit(
                      { action: "update-theme", theme: value },
                      { method: "post" }
                    )
                  }
                  variant="secondary/small"
                  dropdownIcon
                  items={["classic", "system", "dark", "light"]}
                  text={renderTheme}
                  className="w-44"
                >
                  {(items) =>
                    items.map((item) => (
                      <SelectItem key={item} value={item} icon={themeIcon(item)}>
                        {themeLabel(item)}
                      </SelectItem>
                    ))
                  }
                </Select>
              </div>
              {theme !== "classic" && (
                <div className="mt-4 flex w-full items-center justify-between gap-4">
                  <Label>Contrast</Label>
                  <Slider
                    variant="settings"
                    className="w-44"
                    aria-label="Contrast"
                    min={0}
                    max={100}
                    step={5}
                    value={[contrastPreview]}
                    onValueChange={(values) => {
                      // Live preview before the preference persists
                      const value = values[0] ?? 0;
                      setContrastPreview(value);
                      document.documentElement.style.setProperty(
                        "--theme-contrast",
                        String(value / 100)
                      );
                    }}
                    onValueCommit={(values) =>
                      contrastFetcher.submit(
                        { action: "update-contrast", contrast: String(values[0] ?? 0) },
                        { method: "post" }
                      )
                    }
                  />
                </div>
              )}
            </>
          )}
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
