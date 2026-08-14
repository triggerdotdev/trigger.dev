import { getFormProps, getInputProps, useForm } from "@conform-to/react";
import { useEffect, useRef, useState } from "react";
import { conformZodMessage, parseWithZod } from "@conform-to/zod";
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
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Slider } from "~/components/primitives/Slider";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Switch } from "~/components/primitives/Switch";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import {
  SETTINGS_ROW_TITLE_GAP,
  SettingsRowDescription,
} from "~/components/primitives/SettingsLayout";
import {
  CustomizeSidebarDialog,
  type CustomizeSidebarSection,
} from "~/components/navigation/CustomizeSidebarDialog";
import {
  favoritePageIcon,
  favoritePageIconClassName,
  useFavorites,
} from "~/components/navigation/favoritePages";
import { buildSideMenuSections } from "~/components/navigation/sideMenuSections";
import {
  ALL_THEME_OPTIONS,
  SYSTEM_DARK_OPTIONS,
  SYSTEM_LIGHT_OPTIONS,
  type ThemeOption,
  THEME_OPTIONS_BY_VALUE,
  themeOptionIcon,
} from "~/components/themeOptions";
import { prisma } from "~/db.server";
import { SelectBestEnvironmentPresenter } from "~/presenters/SelectBestEnvironmentPresenter.server";
import { useFeatureFlags } from "~/hooks/useFeatureFlags";
import {
  applyThemePreference,
  type ThemeAppearance,
  useThemeAppearance,
} from "~/hooks/useSystemThemeSync";
import { useFeatures } from "~/hooks/useFeatures";
import { useHasAdminAccess, useUser } from "~/hooks/useUser";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { updateUser } from "~/models/user.server";
import {
  updateContrastPreference,
  updateIconContrastPreference,
  updateSystemThemePreference,
  updateThemePreference,
  updateUnderlineLinksPreference,
} from "~/services/dashboardPreferences.server";
import {
  normalizeIconContrast,
  normalizeSystemDarkTheme,
  normalizeSystemLightTheme,
  normalizeThemeContrast,
  normalizeUnderlineLinks,
  normalizeThemePreference,
  SystemDarkTheme,
  SystemLightTheme,
  type ThemePreference,
} from "~/utils/themePreference";
import { cachedFlag } from "~/v3/featureFlags.server";
import { requireUser, requireUserId } from "~/services/session.server";
import { emailSchema, MAX_EMAIL_LENGTH } from "~/utils/emailValidation";
import { accountPath } from "~/utils/pathBuilder";
import { pageMeta } from "~/utils/pageTitle";
import { cn } from "~/utils/cn";

export const meta = pageMeta("Your profile");

/** Floor of the contrast slider. 0 is meaningful now: it's the palette the
 *  Classic theme shipped, so the bottom of the range has to stay reachable. */
const MIN_CONTRAST = 0;

/** The contrast the slider ticks and labels as "Default". Matches
 *  `DEFAULT_THEME_CONTRAST`, the value applied when none is saved. */
const DEFAULT_CONTRAST_MARK = 0;

function themeIcon(value: ThemePreference, appearance: ThemeAppearance) {
  const Icon = themeOptionIcon(THEME_OPTIONS_BY_VALUE[value], appearance);
  // shrink-0: without it the icon is the flex item that gives way to a long
  // label, and "System" squashes it to a sliver.
  return <Icon className="size-4 shrink-0 text-text-bright" />;
}

/**
 * Picker for one end of the `system` setting: Light or White, Dark or Black. Same
 * shape as the Interface theme select, with its own two options.
 */
function SystemThemeSelect({
  label,
  value,
  options,
  appearance,
  onChange,
}: {
  label: string;
  value: string;
  options: ThemeOption[];
  appearance: ThemeAppearance;
  onChange: (value: string) => void;
}) {
  return (
    <Select<string, string>
      aria-label={`${label} system theme`}
      value={value}
      setValue={onChange}
      variant="secondary/small"
      dropdownIcon
      items={options.map((option) => option.value)}
      text={(item) => (
        <span className="flex items-center gap-1.5">
          {themeIcon(item as ThemePreference, appearance)}
          {THEME_OPTIONS_BY_VALUE[item as ThemePreference].label}
        </span>
      )}
      className="w-fit"
      popoverClassName="min-w-27"
    >
      {(items) =>
        items.map((item) => (
          <SelectItem
            key={item}
            value={item}
            icon={themeIcon(item as ThemePreference, appearance)}
            className="text-text-bright"
          >
            {THEME_OPTIONS_BY_VALUE[item as ThemePreference].label}
          </SelectItem>
        ))
      }
    </Select>
  );
}

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

  // The customize modal's section list is built from the side menu's items, which
  // are keyed to a project and environment. Resolve the user's current one so the
  // modal can open here rather than sending them into the app to find it. Null
  // when they have no project yet, and the row hides itself.
  let sidebarContext: {
    organization: { slug: string };
    project: { slug: string };
    environment: { slug: string };
  } | null = null;
  try {
    const { organization, project, environment } = await new SelectBestEnvironmentPresenter().call({
      user,
    });
    sidebarContext = {
      organization: { slug: organization.slug },
      project: { slug: project.slug },
      environment: { slug: environment.slug },
    };
  } catch {
    // No project to customize a sidebar for
  }

  return json({ showThemeSwitcher, sidebarContext });
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

  if (formData.get("action") === "update-icon-contrast") {
    const user = await requireUser(request);
    const showThemeSwitcher =
      user.admin || (await cachedFlag({ key: "hasThemeSwitcher", defaultValue: false }));
    if (!showThemeSwitcher) {
      return json({ error: "Not available" }, { status: 404 });
    }
    await updateIconContrastPreference({
      user,
      iconContrast: formData.get("iconContrast") === "true",
    });
    return json({ success: true });
  }

  if (formData.get("action") === "update-underline-links") {
    const user = await requireUser(request);
    const showThemeSwitcher =
      user.admin || (await cachedFlag({ key: "hasThemeSwitcher", defaultValue: false }));
    if (!showThemeSwitcher) {
      return json({ error: "Not available" }, { status: 404 });
    }
    await updateUnderlineLinksPreference({
      user,
      underlineLinks: formData.get("underlineLinks") === "true",
    });
    return json({ success: true });
  }

  if (formData.get("action") === "update-system-theme") {
    const user = await requireUser(request);
    const showThemeSwitcher =
      user.admin || (await cachedFlag({ key: "hasThemeSwitcher", defaultValue: false }));
    if (!showThemeSwitcher) {
      return json({ error: "Not available" }, { status: 404 });
    }
    // Parsed strictly: an unknown end or theme should fail rather than silently
    // resetting which theme `system` lands on.
    const end = formData.get("end");
    if (end === "light") {
      const theme = SystemLightTheme.safeParse(formData.get("theme"));
      if (!theme.success) return json({ error: "Invalid theme" }, { status: 400 });
      await updateSystemThemePreference({ user, end: "systemLightTheme", theme: theme.data });
      return json({ success: true });
    }
    if (end === "dark") {
      const theme = SystemDarkTheme.safeParse(formData.get("theme"));
      if (!theme.success) return json({ error: "Invalid theme" }, { status: 400 });
      await updateSystemThemePreference({ user, end: "systemDarkTheme", theme: theme.data });
      return json({ success: true });
    }
    return json({ error: "Invalid end" }, { status: 400 });
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

/**
 * Opens the side menu's own "Customize sidebar" modal from here, so the settings row doesn't send
 * anyone into the app to find it. The section list is built from the same source the side menu
 * renders from, keyed to the user's current project and environment.
 *
 * The fetcher lives here rather than in the dialog because closing the dialog unmounts it, which
 * would abort a save mid-request - the same reason the side menu owns its copy.
 */
function CustomizeSidebarButton({
  context,
}: {
  context: {
    organization: { slug: string };
    project: { slug: string };
    environment: { slug: string };
  };
}) {
  const user = useUser();
  const isAdmin = useHasAdminAccess();
  const featureFlags = useFeatureFlags();
  const { isManagedCloud } = useFeatures();
  const favorites = useFavorites();
  const [isOpen, setIsOpen] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const fetcher = useFetcher<{ success: boolean }>();
  // The fetcher's data outlives a confirm, so only settle once THIS submission has been in flight.
  const submitSeenRef = useRef(false);

  useEffect(() => {
    if (!isConfirming) return;
    if (fetcher.state !== "idle") {
      submitSeenRef.current = true;
      return;
    }
    if (!submitSeenRef.current) return;
    setIsConfirming(false);
    if (fetcher.data?.success) {
      setIsOpen(false);
    } else {
      setError("Couldn't save your changes. Please try again.");
    }
  }, [isConfirming, fetcher.state, fetcher.data]);

  const sideMenuPrefs = user.dashboardPreferences.sideMenu;
  const sections: CustomizeSidebarSection[] = [
    ...(favorites.length > 0
      ? [
          {
            id: "favorites",
            title: "Favorites",
            items: favorites.map((favorite) => ({
              id: favorite.id,
              name: favorite.label,
              icon: favoritePageIcon(favorite.icon),
              iconClassName: favoritePageIconClassName(favorite.icon),
              isFavorite: true,
            })),
          },
        ]
      : []),
    ...buildSideMenuSections({ ...context, isAdmin, featureFlags, isManagedCloud }).map(
      (section) => ({
        id: section.id,
        title: section.title,
        items: section.items.map((item) => ({
          id: item.id,
          name: item.name,
          icon: item.icon,
          defaultHidden: item.defaultHidden,
        })),
      })
    ),
  ];

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) {
          setIsConfirming(false);
          setError(undefined);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary/small">Customize</Button>
      </DialogTrigger>
      {/* Mounted only while open so the modal re-seeds from current preferences each time */}
      {isOpen && (
        <CustomizeSidebarDialog
          sections={sections}
          prefs={{
            sectionOrder: sideMenuPrefs?.sectionOrder,
            hiddenItems: sideMenuPrefs?.hiddenItems,
            sectionItemOrder: sideMenuPrefs?.sectionItemOrder,
          }}
          onConfirm={(payload) => {
            setError(undefined);
            setIsConfirming(true);
            submitSeenRef.current = false;
            fetcher.submit(
              { customization: JSON.stringify(payload) },
              { method: "POST", action: "/resources/preferences/sidemenu" }
            );
          }}
          isConfirming={isConfirming}
          confirmError={error}
        />
      )}
    </Dialog>
  );
}

export default function Page() {
  const user = useUser();
  const { showThemeSwitcher, sidebarContext } = useLoaderData<typeof loader>();
  const lastSubmission = useActionData();
  const themeFetcher = useFetcher();
  const contrastFetcher = useFetcher();
  const iconContrastFetcher = useFetcher();
  const pendingIconContrast = iconContrastFetcher.formData?.get("iconContrast");
  const iconContrast =
    typeof pendingIconContrast === "string"
      ? pendingIconContrast === "true"
      : normalizeIconContrast(user.dashboardPreferences.iconContrast);
  const underlineLinksFetcher = useFetcher();
  const pendingUnderlineLinks = underlineLinksFetcher.formData?.get("underlineLinks");
  const underlineLinks =
    typeof pendingUnderlineLinks === "string"
      ? pendingUnderlineLinks === "true"
      : normalizeUnderlineLinks(user.dashboardPreferences.underlineLinks);
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
  // Black and White draw themselves against the active theme, so the icons
  // follow the optimistic pick rather than waiting for the write to land.
  const appearance = useThemeAppearance(theme);

  // Which theme `system` lands on at each end. One fetcher per end so picking
  // both in quick succession can't cancel the first.
  const systemLightFetcher = useFetcher();
  const systemDarkFetcher = useFetcher();
  const pendingSystemLight = systemLightFetcher.formData?.get("theme");
  const pendingSystemDark = systemDarkFetcher.formData?.get("theme");
  const systemLightTheme = normalizeSystemLightTheme(
    typeof pendingSystemLight === "string"
      ? pendingSystemLight
      : user.dashboardPreferences.systemLightTheme
  );
  const systemDarkTheme = normalizeSystemDarkTheme(
    typeof pendingSystemDark === "string"
      ? pendingSystemDark
      : user.dashboardPreferences.systemDarkTheme
  );
  const systemThemes = { light: systemLightTheme, dark: systemDarkTheme };

  const saveSystemTheme = (end: "light" | "dark", value: string) => {
    const fetcher = end === "light" ? systemLightFetcher : systemDarkFetcher;
    // Re-resolve straight away: on `system` this changes which theme is showing
    applyThemePreference(theme, {
      ...systemThemes,
      [end]: value,
    } as typeof systemThemes);
    fetcher.submit({ action: "update-system-theme", end, theme: value }, { method: "post" });
  };

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

  // Dragging previews through the CSS var; releasing (or clicking the default
  // mark) persists it.
  const previewContrast = (value: number) => {
    setContrastPreview(value);
    document.documentElement.style.setProperty("--theme-contrast", String(value / 100));
  };
  const saveContrast = (value: number) =>
    contrastFetcher.submit(
      { action: "update-contrast", contrast: String(value) },
      { method: "post" }
    );

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
                    variant="minimal/medium"
                    defaultChecked={user.marketingEmails}
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
              <div className="mt-8 w-full border-b border-grid-dimmed pb-3">
                <Header2>Appearance</Header2>
              </div>
              <div className="flex min-h-16 w-full items-center border-b border-grid-dimmed">
                <div className="flex w-full items-center justify-between gap-4">
                  <div className={cn("flex-1", SETTINGS_ROW_TITLE_GAP)}>
                    <Label>Interface theme</Label>
                    <SettingsRowDescription>
                      Choose your interface color scheme
                    </SettingsRowDescription>
                  </div>
                  <div className="flex flex-none items-center">
                    <Select<ThemePreference, ThemePreference>
                      aria-label="Interface theme"
                      value={theme}
                      setValue={(value) => {
                        // Applied here so the theme lands immediately rather than
                        // on the root loader's next pass (see applyThemePreference).
                        applyThemePreference(normalizeThemePreference(value), systemThemes);
                        themeFetcher.submit(
                          { action: "update-theme", theme: value },
                          { method: "post" }
                        );
                      }}
                      variant="secondary/small"
                      dropdownIcon
                      items={ALL_THEME_OPTIONS.map((option) => option.value)}
                      text={(value) => (
                        <span className="flex items-center gap-1.5">
                          {themeIcon(value, appearance)}
                          {THEME_OPTIONS_BY_VALUE[value].label}
                        </span>
                      )}
                      // Hugs its label; the popover keeps the wider floor below so
                      // the options aren't cramped by the shortest one.
                      className="w-fit"
                      // The popover's 180px floor left a gap past the longest
                      // label; match the trigger instead.
                      popoverClassName="min-w-27"
                    >
                      {(items) =>
                        items.map((item) => (
                          <SelectItem
                            key={item}
                            value={item}
                            icon={themeIcon(item, appearance)}
                            className="text-text-bright"
                          >
                            {THEME_OPTIONS_BY_VALUE[item].label}
                          </SelectItem>
                        ))
                      }
                    </Select>
                  </div>
                </div>
              </div>
              {/*
                Which theme each end of the OS setting resolves to — only meaningful on
                `system`, so the two rows slide and fade open when it's picked. Animating the
                grid row track rather than a height keeps the rows at their natural size, and
                the `visibility` transition holds them on screen while they collapse but
                takes them out of the tab order once shut.
              */}
              <div
                className="grid w-full transition-[grid-template-rows,opacity,visibility] duration-200 ease-in-out"
                style={{
                  gridTemplateRows: theme === "system" ? "1fr" : "0fr",
                  opacity: theme === "system" ? 1 : 0,
                  visibility: theme === "system" ? "visible" : "hidden",
                }}
              >
                {/* Clips the rows as the track shrinks, and lets them shrink at all: a grid
                    item only drops below its content height once its overflow isn't visible.
                    Left unpositioned on purpose, so the theme selects' popovers — absolute,
                    against a containing block further up — still escape it when open. */}
                <div className="overflow-hidden">
                  <div className="flex min-h-16 w-full items-center border-b border-grid-dimmed">
                    <div className="flex w-full items-center justify-between gap-4">
                      <div className={cn("flex-1", SETTINGS_ROW_TITLE_GAP)}>
                        <Label>Light</Label>
                        <SettingsRowDescription>
                          Choose a theme for the light system setting
                        </SettingsRowDescription>
                      </div>
                      <div className="flex flex-none items-center">
                        <SystemThemeSelect
                          label="Light"
                          value={systemLightTheme}
                          options={SYSTEM_LIGHT_OPTIONS}
                          appearance={appearance}
                          onChange={(value) => saveSystemTheme("light", value)}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="flex min-h-16 w-full items-center border-b border-grid-dimmed">
                    <div className="flex w-full items-center justify-between gap-4">
                      <div className={cn("flex-1", SETTINGS_ROW_TITLE_GAP)}>
                        <Label>Dark</Label>
                        <SettingsRowDescription>
                          Choose the theme for the dark system setting
                        </SettingsRowDescription>
                      </div>
                      <div className="flex flex-none items-center">
                        <SystemThemeSelect
                          label="Dark"
                          value={systemDarkTheme}
                          options={SYSTEM_DARK_OPTIONS}
                          appearance={appearance}
                          onChange={(value) => saveSystemTheme("dark", value)}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex min-h-16 w-full items-center border-b border-grid-dimmed">
                <div className="flex w-full items-center justify-between gap-4">
                  <div className={cn("flex-1", SETTINGS_ROW_TITLE_GAP)}>
                    <Label>Contrast</Label>
                    <SettingsRowDescription>Adjust the interface contrast</SettingsRowDescription>
                  </div>
                  <div className="flex flex-none items-center">
                    <Slider
                      variant="settings"
                      className="w-44"
                      aria-label="Contrast"
                      min={MIN_CONTRAST}
                      max={100}
                      step={1}
                      marks={[
                        {
                          value: DEFAULT_CONTRAST_MARK,
                          label: "Reset to default",
                          onSelect: () => {
                            previewContrast(DEFAULT_CONTRAST_MARK);
                            saveContrast(DEFAULT_CONTRAST_MARK);
                          },
                        },
                      ]}
                      valueTooltip={(value) =>
                        value === DEFAULT_CONTRAST_MARK ? "Default" : `${value}%`
                      }
                      value={[contrastPreview]}
                      onValueChange={(values) => previewContrast(values[0] ?? 0)}
                      onValueCommit={(values) => saveContrast(values[0] ?? 0)}
                    />
                  </div>
                </div>
              </div>

              <div className="mt-8 w-full border-b border-grid-dimmed pb-3">
                <Header2>Interface</Header2>
              </div>
              {sidebarContext && (
                <div className="flex min-h-16 w-full items-center border-b border-grid-dimmed">
                  <div className="flex w-full items-center justify-between gap-4">
                    <div className={cn("flex-1", SETTINGS_ROW_TITLE_GAP)}>
                      <Label>App sidebar</Label>
                      <SettingsRowDescription>
                        Customize sidebar item visibility, order and rename favorites
                      </SettingsRowDescription>
                    </div>
                    <div className="flex flex-none items-center">
                      <CustomizeSidebarButton context={sidebarContext} />
                    </div>
                  </div>
                </div>
              )}
              <div className="flex min-h-16 w-full items-center border-b border-grid-dimmed">
                <div className="flex w-full items-center justify-between gap-4">
                  <div className={cn("flex-1", SETTINGS_ROW_TITLE_GAP)}>
                    <Label>Distinguish without color</Label>
                    <SettingsRowDescription>
                      Raise the contrast of icons, badges and charts, and give color-only items a
                      distinct shape
                    </SettingsRowDescription>
                  </div>
                  <div className="flex flex-none items-center">
                    <Switch
                      variant="minimal/medium"
                      aria-label="Distinguish without color"
                      checked={iconContrast}
                      onCheckedChange={(checked) =>
                        iconContrastFetcher.submit(
                          {
                            action: "update-icon-contrast",
                            iconContrast: checked ? "true" : "false",
                          },
                          { method: "post" }
                        )
                      }
                      className="w-fit"
                    />
                  </div>
                </div>
              </div>
              <div className="flex min-h-16 w-full items-center border-b border-grid-dimmed">
                <div className="flex w-full items-center justify-between gap-4">
                  <div className={cn("flex-1", SETTINGS_ROW_TITLE_GAP)}>
                    <Label>Underline links</Label>
                    <SettingsRowDescription>
                      Always underline links in body text
                    </SettingsRowDescription>
                  </div>
                  <div className="flex flex-none items-center">
                    <Switch
                      variant="minimal/medium"
                      aria-label="Underline links"
                      checked={underlineLinks}
                      onCheckedChange={(checked) =>
                        underlineLinksFetcher.submit(
                          {
                            action: "update-underline-links",
                            underlineLinks: checked ? "true" : "false",
                          },
                          { method: "post" }
                        )
                      }
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
