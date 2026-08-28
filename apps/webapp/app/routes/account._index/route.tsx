import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  type ActionFunction,
  json,
  type LoaderFunctionArgs,
  type SerializeFrom,
} from "@remix-run/server-runtime";
import { z } from "zod";
import { EditPencilIcon } from "~/assets/icons/EditPencilIcon";
import { ProfilePhotoEditor } from "~/components/ProfilePhotoEditor";
import { UserProfilePhoto } from "~/components/UserProfilePhoto";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Slider } from "~/components/primitives/Slider";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Switch } from "~/components/primitives/Switch";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useToast } from "~/components/primitives/Toast";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import {
  SETTINGS_ROW_TITLE_GAP,
  SETTINGS_SECTION_GAP,
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
import {
  applyThemeContrast,
  applyThemePreference,
  type ThemeAppearance,
  useThemeAppearance,
} from "~/hooks/useSystemThemeSync";
import { useFeatures } from "~/hooks/useFeatures";
import { useHasAdminAccess, useUser } from "~/hooks/useUser";
import { updateUserEmail, updateUserMarketingEmails, updateUserName } from "~/models/user.server";
import { logger } from "~/services/logger.server";
import { type EmailOwnership, getEmailOwnership } from "~/services/ssoManagedIdentity.server";
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
  ThemePreference,
} from "~/utils/themePreference";
import { cachedFlag, resolveOrganizationFeatureFlags } from "~/v3/featureFlags.server";
import { requireUser } from "~/services/session.server";
import { isAvatarUploadsEnabled } from "~/services/userAvatar.server";
import { emailSchema, MAX_EMAIL_LENGTH } from "~/utils/emailValidation";
import { pageMeta } from "~/utils/pageTitle";
import { cn } from "~/utils/cn";

export const meta = pageMeta("Your profile");

const MIN_CONTRAST = 0;

const DEFAULT_CONTRAST_MARK = 0;

const CONTRAST_SAVE_DEBOUNCE_MS = 400;

function themeIcon(value: ThemePreference, appearance: ThemeAppearance) {
  const Icon = themeOptionIcon(THEME_OPTIONS_BY_VALUE[value], appearance);
  // shrink-0 stops a long label squashing the icon.
  return <Icon className="size-4 shrink-0 text-text-bright" />;
}

/** Module scope keeps the `text` render prop a stable reference. */
function themeOptionLabel(value: ThemePreference, appearance: ThemeAppearance) {
  return (
    <span className="flex items-center gap-1.5">
      {themeIcon(value, appearance)}
      {THEME_OPTIONS_BY_VALUE[value].label}
    </span>
  );
}

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
      text={(item) => themeOptionLabel(item as ThemePreference, appearance)}
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

/**
 * Must be rendered inside an ancestor marked `group/preview`. Reveals on
 * `:focus-visible`, not `focus-within`, so a click doesn't strand it on screen.
 */
function StrongerColorsPreview() {
  return (
    <span
      aria-hidden
      className="inline-flex rounded bg-success/10 px-2 py-0.5 text-xs font-medium text-success opacity-0 transition-opacity system:bg-success system:text-white group-hover/preview:opacity-100 group-has-[:focus-visible]/preview:opacity-100"
    >
      Example
    </span>
  );
}

const MAX_NAME_LENGTH = 50;

const NameSchema = z.object({
  name: z
    .string({ required_error: "You must enter a name" })
    .trim()
    .min(2, "Your name must be at least 2 characters long")
    .max(MAX_NAME_LENGTH, `Your name must be ${MAX_NAME_LENGTH} characters or fewer`),
});

const EmailSchema = z.object({
  // Trim first: a trailing space fails as "invalid email".
  email: z.string({ required_error: "You must enter an email address" }).trim().pipe(emailSchema),
});

const MarketingEmailsSchema = z.object({
  // Not `z.coerce.boolean()`: "false" is truthy.
  marketingEmails: z.union([z.literal("true"), z.literal("false")]).transform((v) => v === "true"),
});

type ProfileUpdateResult = { success: true } | { success: false; error: string };

function profileUpdateError(error: string, status: number) {
  return json({ success: false as const, error }, { status });
}

/**
 * Shared gate for every write on this page. Returns the user so the caller
 * needn't load it a second time.
 */
async function requireOwnAccountWrite(request: Request) {
  const user = await requireUser(request);
  if (user.isImpersonating) {
    return {
      error: profileUpdateError("You can't change this while impersonating another user.", 403),
    };
  }

  return { user };
}

/** The gate above, plus the theme-switcher flag. */
async function requireAppearanceAccess(request: Request) {
  const gate = await requireOwnAccountWrite(request);
  if ("error" in gate) return gate;

  const showThemeSwitcher =
    gate.user.admin || (await cachedFlag({ key: "hasThemeSwitcher", defaultValue: false }));
  if (!showThemeSwitcher) {
    return { error: profileUpdateError("Not available", 404) };
  }

  return gate;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const showThemeSwitcher =
    user.admin || (await cachedFlag({ key: "hasThemeSwitcher", defaultValue: false }));

  // Null when the user has no project yet; the row hides itself.
  let sidebarContext: {
    organization: { slug: string };
    project: { slug: string };
    environment: { slug: string };
    // Resolved here, not from route matches: /account sits outside an org, so
    // `useFeatureFlags` would see none and the dialog would offer a shorter
    // section list than the side menu - and saving it drops the rest.
    featureFlags: Awaited<ReturnType<typeof resolveOrganizationFeatureFlags>>;
  } | null = null;
  try {
    const { organization, project, environment } = await new SelectBestEnvironmentPresenter().call({
      user,
    });
    sidebarContext = {
      organization: { slug: organization.slug },
      project: { slug: project.slug },
      environment: { slug: environment.slug },
      featureFlags: await resolveOrganizationFeatureFlags(organization.featureFlags),
    };
  } catch (error) {
    logger.debug("Account page: no sidebar context for this user", {
      userId: user.id,
      error: error instanceof Error ? error.message : error,
    });
  }

  return json({
    showThemeSwitcher,
    sidebarContext,
    avatarUploadsEnabled: isAvatarUploadsEnabled(),
  });
}

export const action: ActionFunction = async ({ request }) => {
  const formData = await request.formData();

  if (formData.get("action") === "update-theme") {
    const gate = await requireAppearanceAccess(request);
    if ("error" in gate) return gate.error;
    // Strict, matching /resources/preferences/theme: an unknown value must fail
    // rather than quietly resetting a saved theme to the default.
    const theme = ThemePreference.safeParse(formData.get("theme"));
    if (!theme.success) return profileUpdateError("Invalid theme", 400);
    await updateThemePreference({ user: gate.user, theme: theme.data });
    return json({ success: true });
  }

  if (formData.get("action") === "update-contrast") {
    const gate = await requireAppearanceAccess(request);
    if ("error" in gate) return gate.error;
    const contrast = normalizeThemeContrast(formData.get("contrast"));
    await updateContrastPreference({ user: gate.user, contrast });
    return json({ success: true });
  }

  if (formData.get("action") === "update-icon-contrast") {
    const gate = await requireAppearanceAccess(request);
    if ("error" in gate) return gate.error;
    await updateIconContrastPreference({
      user: gate.user,
      iconContrast: formData.get("iconContrast") === "true",
    });
    return json({ success: true });
  }

  if (formData.get("action") === "update-underline-links") {
    const gate = await requireAppearanceAccess(request);
    if ("error" in gate) return gate.error;
    await updateUnderlineLinksPreference({
      user: gate.user,
      underlineLinks: formData.get("underlineLinks") === "true",
    });
    return json({ success: true });
  }

  if (formData.get("action") === "update-system-theme") {
    const gate = await requireAppearanceAccess(request);
    if ("error" in gate) return gate.error;
    // Strict: an unknown value must fail, not silently reset.
    const end = formData.get("end");
    if (end === "light") {
      const theme = SystemLightTheme.safeParse(formData.get("theme"));
      if (!theme.success) return profileUpdateError("Invalid theme", 400);
      await updateSystemThemePreference({
        user: gate.user,
        end: "systemLightTheme",
        theme: theme.data,
      });
      return json({ success: true });
    }
    if (end === "dark") {
      const theme = SystemDarkTheme.safeParse(formData.get("theme"));
      if (!theme.success) return profileUpdateError("Invalid theme", 400);
      await updateSystemThemePreference({
        user: gate.user,
        end: "systemDarkTheme",
        theme: theme.data,
      });
      return json({ success: true });
    }
    return profileUpdateError("Invalid end", 400);
  }

  if (formData.get("action") === "update-name") {
    const gate = await requireOwnAccountWrite(request);
    if ("error" in gate) return gate.error;

    const submission = NameSchema.safeParse({ name: formData.get("name") });
    if (!submission.success) {
      return profileUpdateError(
        submission.error.issues[0]?.message ?? "That name isn't valid.",
        400
      );
    }

    await updateUserName({ id: gate.user.id, name: submission.data.name });
    return json({ success: true as const });
  }

  if (formData.get("action") === "update-email") {
    const gate = await requireOwnAccountWrite(request);
    if ("error" in gate) return gate.error;

    // Re-checked: the loader only picked the modal.
    const submission = EmailSchema.safeParse({ email: formData.get("email") });
    if (!submission.success) {
      return profileUpdateError(
        submission.error.issues[0]?.message ?? "That email address isn't valid.",
        400
      );
    }

    const { email } = submission.data;

    const ownership = await getEmailOwnership(gate.user, email);
    if (ownership === "idp") {
      return profileUpdateError(
        "Your email address is managed by your organization's identity provider.",
        403
      );
    }
    if (ownership === "unknown") {
      return profileUpdateError(
        "We couldn't check your single sign-on settings just now. Please try again shortly.",
        503
      );
    }
    const existingUser = await prisma.user.findFirst({ where: { email } });
    if (existingUser && existingUser.id !== gate.user.id) {
      return profileUpdateError("Email is already being used by a different account", 400);
    }

    await updateUserEmail({ id: gate.user.id, email });
    return json({ success: true as const });
  }

  if (formData.get("action") === "update-marketing-emails") {
    const gate = await requireOwnAccountWrite(request);
    if ("error" in gate) return gate.error;

    const submission = MarketingEmailsSchema.safeParse({
      marketingEmails: formData.get("marketingEmails"),
    });
    if (!submission.success) {
      return profileUpdateError("That preference isn't valid.", 400);
    }

    // No-op when the stored value already matches.
    await updateUserMarketingEmails({
      id: gate.user.id,
      marketingEmails: submission.data.marketingEmails,
    });
    return json({ success: true as const });
  }

  return json({ success: false as const, error: "Unknown action" }, { status: 400 });
};

/** `data` outlives a submission, so settle only once this one has flown. */
function useProfileFieldUpdate({
  successMessage,
  onSuccess,
}: {
  successMessage: string;
  onSuccess: () => void;
}) {
  const fetcher = useFetcher<ProfileUpdateResult>();
  const toast = useToast();
  const [error, setError] = useState<string>();
  const submitSeenRef = useRef(false);

  useEffect(() => {
    if (fetcher.state !== "idle") {
      submitSeenRef.current = true;
      return;
    }
    if (!submitSeenRef.current) return;
    submitSeenRef.current = false;

    if (fetcher.data?.success) {
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
      setError(undefined);
      toast.success(successMessage);
      onSuccess();
      return;
    }

    // A dropped request leaves `data` undefined.
    const message = fetcher.data?.error ?? "Something went wrong. Please try again.";
    setError(message);
    toast.error(message);
  }, [fetcher.state, fetcher.data, toast, successMessage, onSuccess]);

  return { fetcher, error, setError, isSubmitting: fetcher.state !== "idle" };
}

function ChangeProfilePhotoButton() {
  const user = useUser();
  const [isOpen, setIsOpen] = useState(false);
  const fetcher = useFetcher<{ avatarUrl?: string | null; error?: string }>();
  const toast = useToast();
  const isSaving = fetcher.state !== "idle";
  const submitSeenRef = useRef(false);
  const actionRef = useRef<"save" | "remove">("save");

  useEffect(() => {
    if (fetcher.state !== "idle") {
      submitSeenRef.current = true;
      return;
    }
    if (!submitSeenRef.current) return;
    submitSeenRef.current = false;

    const removing = actionRef.current === "remove";
    const succeeded = removing
      ? fetcher.data?.avatarUrl === null
      : Boolean(fetcher.data?.avatarUrl);

    if (succeeded) {
      // oxlint-disable-next-line react/set-state-in-effect -- Closes the modal once the change has landed.
      setIsOpen(false);
      toast.success(
        removing
          ? "Your profile picture has been removed."
          : "Your profile picture has been updated."
      );
      return;
    }

    toast.error(fetcher.data?.error ?? "Something went wrong. Please try again.");
  }, [fetcher.state, fetcher.data, toast]);

  const save = (blob: Blob) => {
    actionRef.current = "save";
    const formData = new FormData();
    formData.append("image", blob, "avatar.png");
    fetcher.submit(formData, {
      method: "post",
      action: "/resources/account/avatar",
      encType: "multipart/form-data",
    });
  };

  // Only our own uploads are app-relative; OAuth avatars are absolute URLs.
  const uploadedAvatarUrl = user.avatarUrl?.startsWith("/") ? user.avatarUrl : undefined;

  const remove = () => {
    actionRef.current = "remove";
    fetcher.submit(null, { method: "delete", action: "/resources/account/avatar" });
  };

  return (
    <>
      <SimpleTooltip
        asChild
        tabbable
        disableHoverableContent
        content="Change your profile picture"
        button={
          <button
            type="button"
            onClick={() => setIsOpen(true)}
            aria-label="Change your profile picture"
            className="focus-custom group cursor-pointer rounded-full outline-hidden"
          >
            <UserProfilePhoto
              className="size-8 transition group-hover:opacity-60"
              strokeWidth={1.5}
            />
          </button>
        }
      />
      <ProfilePhotoEditor
        open={isOpen}
        onOpenChange={setIsOpen}
        onSave={save}
        currentAvatarUrl={uploadedAvatarUrl}
        onRemove={remove}
        isSaving={isSaving}
      />
    </>
  );
}

function EditNameButton() {
  const user = useUser();
  const [isOpen, setIsOpen] = useState(false);
  const { fetcher, error, setError, isSubmitting } = useProfileFieldUpdate({
    successMessage: "Your name has been updated.",
    onSuccess: () => setIsOpen(false),
  });

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) setError(undefined);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="secondary/small-icon"
          className="w-6 min-w-0 px-0"
          LeadingIcon={<EditPencilIcon className="size-3.5" />}
          aria-label="Edit your name"
        />
      </DialogTrigger>
      {/* Mounted only while open so the field re-seeds from the stored name each
          time: a `defaultValue` on a field that stays mounted keeps whatever was
          typed and abandoned last time. */}
      {isOpen && (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Full name</DialogTitle>
          </DialogHeader>
          <fetcher.Form method="post">
            <input type="hidden" name="action" value="update-name" />
            <div className="py-4">
              {/* The dialog title already names the field, so the input carries an
                  aria-label rather than a visible one that would repeat it. */}
              <InputGroup fullWidth>
                <Input
                  id="profile-name"
                  name="name"
                  type="text"
                  aria-label="Full name"
                  maxLength={MAX_NAME_LENGTH}
                  placeholder="Your full name"
                  defaultValue={user.name ?? ""}
                  autoFocus
                  onChange={() => setError(undefined)}
                />
                {error && <FormError>{error}</FormError>}
              </InputGroup>
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary/medium" onClick={() => setIsOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary/medium" disabled={isSubmitting}>
                {isSubmitting ? "Saving…" : "Update"}
              </Button>
            </DialogFooter>
          </fetcher.Form>
        </DialogContent>
      )}
    </Dialog>
  );
}

const EMAIL_OWNERSHIP_PATH = "/resources/account/email-ownership";

function EditEmailButton() {
  const user = useUser();
  const [isOpen, setIsOpen] = useState(false);
  const { fetcher, error, setError, isSubmitting } = useProfileFieldUpdate({
    successMessage: "Your email address has been updated.",
    onSuccess: () => setIsOpen(false),
  });
  const ownershipFetcher = useFetcher<{ ownership: EmailOwnership }>();
  const ownership = ownershipFetcher.data?.ownership;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) setError(undefined);
        if (open && ownershipFetcher.state === "idle" && !ownershipFetcher.data) {
          ownershipFetcher.load(EMAIL_OWNERSHIP_PATH);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="secondary/small-icon"
          className="w-6 min-w-0 px-0"
          LeadingIcon={<EditPencilIcon className="size-3.5" />}
          aria-label="Edit your email address"
        />
      </DialogTrigger>
      {/* Mounted only while open, so the field re-seeds from the stored email */}
      {isOpen && (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Email address</DialogTitle>
          </DialogHeader>
          {ownership === undefined ? (
            <Paragraph variant="small" className="pt-2">
              Checking your sign-in settings…
            </Paragraph>
          ) : ownership === "idp" ? (
            <Paragraph variant="small" className="pt-2">
              Your organization uses single sign-on, so your email address is managed by your
              identity provider rather than here. To change it, ask an organization admin to update
              it for you.
            </Paragraph>
          ) : ownership === "unknown" ? (
            <Paragraph variant="small" className="pt-2">
              We couldn't check your organization's single sign-on settings just now, so this can't
              be edited yet. Please try again shortly.
            </Paragraph>
          ) : (
            <fetcher.Form method="post">
              <input type="hidden" name="action" value="update-email" />
              <div className="py-4">
                {/* Labelled by the dialog title, as with the name field above. */}
                <InputGroup fullWidth>
                  <Input
                    id="profile-email"
                    name="email"
                    type="email"
                    aria-label="Email address"
                    maxLength={MAX_EMAIL_LENGTH}
                    placeholder="Your email address"
                    defaultValue={user.email}
                    spellCheck={false}
                    autoFocus
                    onChange={() => setError(undefined)}
                  />
                  {error && <FormError>{error}</FormError>}
                </InputGroup>
              </div>
              <DialogFooter>
                <Button type="button" variant="secondary/medium" onClick={() => setIsOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary/medium" disabled={isSubmitting}>
                  {isSubmitting ? "Saving…" : "Update"}
                </Button>
              </DialogFooter>
            </fetcher.Form>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

const MARKETING_EMAILS_DEBOUNCE_MS = 600;

/** Debounced, one write at a time; the action's rate limit backs it up. */
function MarketingEmailsSwitch() {
  const user = useUser();
  const stored = user.marketingEmails;
  const fetcher = useFetcher<ProfileUpdateResult>();
  const toast = useToast();

  // The last click; `stored` catches up once the write lands.
  const [desired, setDesired] = useState(stored);
  // What the in-flight write is storing, read when it settles.
  const sentRef = useRef(stored);
  const submitSeenRef = useRef(false);
  // `useFetcher` is a fresh object each render; depending on it would
  // restart the debounce timer every render, so keep submit in a ref.
  const submitRef = useRef(fetcher.submit);
  useEffect(() => {
    submitRef.current = fetcher.submit;
  });

  useEffect(() => {
    if (fetcher.state !== "idle") {
      submitSeenRef.current = true;
      return;
    }
    if (!submitSeenRef.current) return;
    submitSeenRef.current = false;

    if (fetcher.data?.success) {
      toast.success(
        sentRef.current
          ? "You'll now receive onboarding emails."
          : "You'll no longer receive onboarding emails."
      );
      return;
    }

    toast.error(
      fetcher.data?.error ?? "Couldn't save your onboarding email preference. Please try again."
    );
    // Resync, or the reconcile below retries a gap it can never close.
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setDesired(stored);
  }, [fetcher.state, fetcher.data, toast, stored]);

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    if (desired === stored) return;

    const timer = setTimeout(() => {
      sentRef.current = desired;
      submitRef.current(
        { action: "update-marketing-emails", marketingEmails: desired ? "true" : "false" },
        { method: "post" }
      );
    }, MARKETING_EMAILS_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [desired, stored, fetcher.state]);

  return (
    <Switch
      id="marketing-emails"
      variant="minimal/medium"
      aria-label="Receive onboarding emails"
      checked={desired}
      onCheckedChange={setDesired}
    />
  );
}

/** The fetcher lives here: closing the dialog unmounts it and would abort a save. */
function CustomizeSidebarButton({
  context,
}: {
  context: NonNullable<SerializeFrom<typeof loader>["sidebarContext"]>;
}) {
  const user = useUser();
  const isAdmin = useHasAdminAccess();
  const { isManagedCloud } = useFeatures();
  const favorites = useFavorites();
  const [isOpen, setIsOpen] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const fetcher = useFetcher<{ success: boolean }>();
  // `data` outlives a confirm, so settle only once this submission has flown.
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
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
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
    ...buildSideMenuSections({ ...context, isAdmin, isManagedCloud }).map((section) => ({
      id: section.id,
      title: section.title,
      items: section.items.map((item) => ({
        id: item.id,
        name: item.name,
        icon: item.icon,
        defaultHidden: item.defaultHidden,
      })),
    })),
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
  const { showThemeSwitcher, sidebarContext, avatarUploadsEnabled } =
    useLoaderData<typeof loader>();
  const themeFetcher = useFetcher<ProfileUpdateResult>();
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
  // Icons follow the optimistic pick, not the settled write.
  const appearance = useThemeAppearance(theme);

  // One fetcher per end, so picking both quickly can't cancel the first.
  const systemLightFetcher = useFetcher<ProfileUpdateResult>();
  const systemDarkFetcher = useFetcher<ProfileUpdateResult>();
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

  const storedTheme = normalizeThemePreference(user.dashboardPreferences.theme);
  const storedSystemLight = normalizeSystemLightTheme(user.dashboardPreferences.systemLightTheme);
  const storedSystemDark = normalizeSystemDarkTheme(user.dashboardPreferences.systemDarkTheme);
  const themeWriteFailed = [themeFetcher, systemLightFetcher, systemDarkFetcher].some(
    (fetcher) => fetcher.state === "idle" && fetcher.data && !fetcher.data.success
  );
  useEffect(() => {
    if (themeWriteFailed) {
      applyThemePreference(storedTheme, { light: storedSystemLight, dark: storedSystemDark });
    }
  }, [themeWriteFailed, storedTheme, storedSystemLight, storedSystemDark]);

  // Resnap to the stored value so a failed save leaves no phantom contrast.
  const [contrastPreview, setContrastPreview] = useState(contrast);
  const [contrastToSave, setContrastToSave] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (contrastFetcher.state === "idle" && contrastToSave === undefined) {
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
      setContrastPreview(contrast);
      applyThemeContrast(contrast);
    }
  }, [contrastFetcher.state, contrast, contrastToSave]);

  const contrastSubmitRef = useRef(contrastFetcher.submit);
  useEffect(() => {
    contrastSubmitRef.current = contrastFetcher.submit;
  });
  useEffect(() => {
    if (contrastToSave === undefined) return;
    const timer = setTimeout(() => {
      contrastSubmitRef.current(
        { action: "update-contrast", contrast: String(contrastToSave) },
        { method: "post" }
      );
      // oxlint-disable-next-line react/set-state-in-effect -- Clears the debounce slot once the write is away.
      setContrastToSave(undefined);
    }, CONTRAST_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [contrastToSave]);

  const previewContrast = (value: number) => {
    setContrastPreview(value);
    applyThemeContrast(value);
  };
  const saveContrast = (value: number) => setContrastToSave(value);

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
          {/* Each row saves itself, so there's no form around the section and no
              Update button at the bottom of it. */}
          <div className="flex min-h-16 w-full items-center border-b border-grid-dimmed">
            <div className="flex w-full items-center justify-between gap-4">
              <InputGroup className="flex-1">
                <Label>Profile picture</Label>
              </InputGroup>
              <div className="flex flex-none items-center">
                {avatarUploadsEnabled ? (
                  <ChangeProfilePhotoButton />
                ) : (
                  <UserProfilePhoto className="size-8" strokeWidth={1.5} />
                )}
              </div>
            </div>
          </div>
          <div className="flex min-h-16 w-full items-center border-b border-grid-dimmed">
            <div className="flex w-full items-center justify-between gap-4">
              <Label>Full name</Label>
              <div className="flex min-w-0 items-center gap-3">
                <Paragraph variant="small" className="min-w-0 break-words text-right">
                  {user.name ?? "Not set"}
                </Paragraph>
                <EditNameButton />
              </div>
            </div>
          </div>
          <div className="flex min-h-16 w-full items-center border-b border-grid-dimmed">
            <div className="flex w-full items-center justify-between gap-4">
              <Label>Email address</Label>
              <div className="flex min-w-0 items-center gap-3">
                {/* break-all: an address has no spaces to wrap at, so a long one
                    would otherwise push the button off the row */}
                <Paragraph variant="small" className="min-w-0 break-all text-right">
                  {user.email}
                </Paragraph>
                <EditEmailButton />
              </div>
            </div>
          </div>
          <div className="flex min-h-16 w-full items-center border-b border-grid-dimmed">
            <div className="flex w-full items-center justify-between gap-4">
              <div className="flex-1">
                <Label htmlFor="marketing-emails">Receive onboarding emails</Label>
              </div>
              <div className="flex flex-none items-center">
                <MarketingEmailsSwitch />
              </div>
            </div>
          </div>
          {showThemeSwitcher && (
            <>
              <div className={cn(SETTINGS_SECTION_GAP, "w-full border-b border-grid-dimmed pb-3")}>
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
                        // Applied here so the theme lands before the loader's next pass.
                        applyThemePreference(normalizeThemePreference(value), systemThemes);
                        themeFetcher.submit(
                          { action: "update-theme", theme: value },
                          { method: "post" }
                        );
                      }}
                      variant="secondary/small"
                      dropdownIcon
                      items={ALL_THEME_OPTIONS.map((option) => option.value)}
                      text={(value) => themeOptionLabel(value, appearance)}
                      className="w-fit"
                      // Match the trigger rather than the popover's wider default floor.
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
              {/* Animating the grid row track keeps the rows at their natural size. */}
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

              <div className={cn(SETTINGS_SECTION_GAP, "w-full border-b border-grid-dimmed pb-3")}>
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
                    <Label>Stronger colors</Label>
                    <SettingsRowDescription>
                      Make colored text, icons and charts easier to read
                    </SettingsRowDescription>
                  </div>
                  {/* The preview is a sibling of the switch inside this hover
                      group rather than tooltip content, so flipping the switch
                      can't dismiss it - a Radix tooltip closes on pointerdown,
                      which fought the one interaction the preview exists for.
                      Hovering anywhere in this group (chip, gap or switch) shows
                      it; leaving hides it. */}
                  <div className="group/preview flex flex-none items-center gap-2">
                    <StrongerColorsPreview />
                    <Switch
                      variant="minimal/medium"
                      aria-label="Stronger colors"
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
