import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { type ActionFunction, json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { EditPencilIcon } from "~/assets/icons/EditPencilIcon";
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
import { useFeatureFlags } from "~/hooks/useFeatureFlags";
import {
  applyThemeContrast,
  applyThemePreference,
  type ThemeAppearance,
  useThemeAppearance,
} from "~/hooks/useSystemThemeSync";
import { useFeatures } from "~/hooks/useFeatures";
import { useHasAdminAccess, useUser } from "~/hooks/useUser";
import { updateUserEmail, updateUserMarketingEmails, updateUserName } from "~/models/user.server";
import { profileUpdateRateLimiter } from "~/services/profileUpdateRateLimiter.server";
import { isSsoManagedUser } from "~/services/ssoManagedIdentity.server";
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
import { pageMeta } from "~/utils/pageTitle";
import { cn } from "~/utils/cn";

export const meta = pageMeta("Your profile");

/** Floor of the contrast slider. 0 is meaningful now: it's the palette the
 *  Classic theme shipped, so the bottom of the range has to stay reachable. */
const MIN_CONTRAST = 0;

/** Where the slider ticks and labels "Default". 0 is the bottom of whichever
 *  theme's range is active - the base palette on most, the faded grid lines on
 *  Black. */
const DEFAULT_CONTRAST_MARK = 0;

function themeIcon(value: ThemePreference, appearance: ThemeAppearance) {
  const Icon = themeOptionIcon(THEME_OPTIONS_BY_VALUE[value], appearance);
  // shrink-0: without it the icon is the flex item that gives way to a long
  // label, and "System" squashes it to a sliver.
  return <Icon className="size-4 shrink-0 text-text-bright" />;
}

/** The icon-and-label pair a theme shows in the picker, shared by the theme
 *  select and the two system light/dark selects. Module scope so the `text`
 *  render prop stays a stable reference rather than a per-render component. */
function themeOptionLabel(value: ThemePreference, appearance: ThemeAppearance) {
  return (
    <span className="flex items-center gap-1.5">
      {themeIcon(value, appearance)}
      {THEME_OPTIONS_BY_VALUE[value].label}
    </span>
  );
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
 * Hover preview for the "Stronger colors" switch: one chip that visibly moves
 * when the preference does. Nothing here sets `data-icon-contrast` - it inherits
 * from <html>, so the chip moves with the rest of the page and can never
 * disagree with what's actually saved.
 *
 * It borrows the Resolved error-status treatment (tinted green, going solid with
 * white text under the preference) rather than a plain accent chip, because the
 * accent tokens alone don't change on the light themes: those themes already
 * darken success and warning for white, to the very same values the
 * high-contrast set uses, so a `text-warning` chip was inert on Light and White.
 * The `system:` swap to a filled chip is driven by the preference directly, so it
 * reads in all four themes.
 *
 * Fades in on hover of an ancestor marked `group/preview`, so it must be rendered
 * inside one. The group is named because Switch's own root is an unnamed `group`
 * whose track styles key off `group-hover:` - an unnamed group here would sit
 * above it and light the track up whenever this chip was hovered.
 *
 * Keyboard focus reveals it too, but via `:focus-visible` rather than
 * `focus-within`: clicking the switch leaves it focused, so `focus-within` would
 * strand the chip on screen after the pointer had left. A mouse click doesn't set
 * `:focus-visible`, so tabbing to the switch shows the chip and clicking it
 * doesn't.
 *
 * It stays mounted at `opacity-0` rather than being conditionally rendered: its
 * width is reserved either way, so the row can't reflow as the pointer arrives.
 * `text-xs` is explicit because the chip used to inherit it from the tooltip it
 * lived in; in the row it would otherwise pick up the page's base size and tower
 * over the description beside it. `aria-hidden` because "Example" tells a screen
 * reader nothing - the chip is the colour, and the switch's own label carries the
 * meaning.
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

/** The name and email rows each save on their own, so each has its own schema
 *  rather than one that would reject the whole profile over a single field. */
const MAX_NAME_LENGTH = 50;

const NameSchema = z.object({
  name: z
    .string({ required_error: "You must enter a name" })
    .trim()
    .min(2, "Your name must be at least 2 characters long")
    .max(MAX_NAME_LENGTH, `Your name must be ${MAX_NAME_LENGTH} characters or fewer`),
});

const EmailSchema = z.object({
  // Trimmed first: a pasted address often carries a trailing space, and
  // `emailSchema` would reject it with an unhelpful "invalid email".
  email: z.string({ required_error: "You must enter an email address" }).trim().pipe(emailSchema),
});

const MarketingEmailsSchema = z.object({
  // Not `z.coerce.boolean()`: it treats the string "false" as truthy.
  marketingEmails: z.union([z.literal("true"), z.literal("false")]).transform((v) => v === "true"),
});

/** What every profile row's fetcher gets back. `error` is written for the person
 *  reading it, because it lands in a toast and under the field. */
type ProfileUpdateResult = { success: true } | { success: false; error: string };

function profileUpdateError(error: string, status: number) {
  return json({ success: false as const, error }, { status });
}

/** First line of the "don't hammer the database" defence, and the only one a
 *  scripted POST can't skip: the client debounce and the no-op write guard both
 *  help, but neither survives someone replaying the request by hand. */
async function checkProfileUpdateRateLimit(userId: string) {
  const limit = await profileUpdateRateLimiter.limit(`user:${userId}`);
  if (limit.success) {
    return undefined;
  }
  return profileUpdateError("Too many changes at once. Please wait a moment and try again.", 429);
}

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const showThemeSwitcher =
    user.admin || (await cachedFlag({ key: "hasThemeSwitcher", defaultValue: false }));

  // Decides which of the two email modals opens. The action re-checks it before
  // writing — this value only picks the UI, so a stale page can't be used to
  // sneak an email change past the identity provider.
  const isSsoManaged = await isSsoManagedUser(user.id);

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

  return json({ showThemeSwitcher, sidebarContext, isSsoManaged });
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

  if (formData.get("action") === "update-name") {
    const rateLimited = await checkProfileUpdateRateLimit(userId);
    if (rateLimited) return rateLimited;

    const submission = NameSchema.safeParse({ name: formData.get("name") });
    if (!submission.success) {
      return profileUpdateError(
        submission.error.issues[0]?.message ?? "That name isn't valid.",
        400
      );
    }

    await updateUserName({ id: userId, name: submission.data.name });
    return json({ success: true as const });
  }

  if (formData.get("action") === "update-email") {
    const rateLimited = await checkProfileUpdateRateLimit(userId);
    if (rateLimited) return rateLimited;

    // Re-checked here, not just in the loader: the loader only chose which modal
    // to render, and an SSO user could post this branch directly.
    if (await isSsoManagedUser(userId)) {
      return profileUpdateError(
        "Your email address is managed by your organization's identity provider.",
        403
      );
    }

    const submission = EmailSchema.safeParse({ email: formData.get("email") });
    if (!submission.success) {
      return profileUpdateError(
        submission.error.issues[0]?.message ?? "That email address isn't valid.",
        400
      );
    }

    const { email } = submission.data;
    const existingUser = await prisma.user.findFirst({ where: { email } });
    if (existingUser && existingUser.id !== userId) {
      return profileUpdateError("Email is already being used by a different account", 400);
    }

    await updateUserEmail({ id: userId, email });
    return json({ success: true as const });
  }

  if (formData.get("action") === "update-marketing-emails") {
    const rateLimited = await checkProfileUpdateRateLimit(userId);
    if (rateLimited) return rateLimited;

    const submission = MarketingEmailsSchema.safeParse({
      marketingEmails: formData.get("marketingEmails"),
    });
    if (!submission.success) {
      return profileUpdateError("That preference isn't valid.", 400);
    }

    // Writes nothing when the stored value already matches, so a duplicate
    // request costs one WHERE that matches no rows.
    await updateUserMarketingEmails({
      id: userId,
      marketingEmails: submission.data.marketingEmails,
    });
    return json({ success: true as const });
  }

  return json({ success: false as const, error: "Unknown action" }, { status: 400 });
};

/**
 * Wiring shared by the two edit modals: submit through a fetcher, toast the
 * outcome once, and keep the message around so it can also sit under the field —
 * the toast says whether it worked, the inline error says which field to fix.
 *
 * The fetcher's `data` outlives a submission, so this only settles once THIS
 * submission has been in flight - the same guard `CustomizeSidebarButton` uses.
 */
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

    // A dropped request leaves `data` undefined, so there's no server message.
    const message = fetcher.data?.error ?? "Something went wrong. Please try again.";
    setError(message);
    toast.error(message);
    // `submitSeenRef` gates the body on a submission having settled, so the
    // extra deps only ever cause a no-op re-run.
  }, [fetcher.state, fetcher.data, toast, successMessage, onSuccess]);

  return { fetcher, error, setError, isSubmitting: fetcher.state !== "idle" };
}

/**
 * The Full name row's action. The name itself is now read-only text in the row,
 * and this is the one place it can be changed.
 */
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

/**
 * The Email address row's action. Which modal opens depends on whether an
 * identity provider owns this account: if it does there is nothing to edit, so
 * the modal explains that and who to ask, and carries no footer to imply
 * otherwise - closing it is the only thing left to do.
 *
 * `isSsoManaged` only picks the modal. The action re-checks it before writing.
 */
function EditEmailButton({ isSsoManaged }: { isSsoManaged: boolean }) {
  const user = useUser();
  const [isOpen, setIsOpen] = useState(false);
  const { fetcher, error, setError, isSubmitting } = useProfileFieldUpdate({
    successMessage: "Your email address has been updated.",
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
          aria-label="Edit your email address"
        />
      </DialogTrigger>
      {/* Mounted only while open, so the field re-seeds from the stored email */}
      {isOpen && (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Email address</DialogTitle>
          </DialogHeader>
          {isSsoManaged ? (
            <Paragraph variant="small" className="pt-2">
              Your organization uses single sign-on, so your email address is managed by your
              identity provider rather than here. To change it, ask an organization admin to update
              it for you.
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

/** How long after the last click the write goes out. Long enough to collapse a
 *  burst of clicks into one request, short enough that a deliberate toggle has
 *  saved by the time you look away. */
const MARKETING_EMAILS_DEBOUNCE_MS = 600;

/**
 * "Receive onboarding emails" saves itself now, so the switch is what paces the
 * writes. Three things keep a spammed switch off the database:
 *
 *  1. it shows the click straight away but only writes once the clicking stops,
 *     so a burst becomes a single request for the value landed on;
 *  2. one write at a time — a click made mid-flight is reconciled after the
 *     current write settles rather than queued behind it;
 *  3. a toggle that ends up back where it started never reaches the server at
 *     all, and the write itself matches no rows if it does (see
 *     `updateUserMarketingEmails`).
 *
 * None of that survives someone posting the form by hand, which is what the
 * per-user rate limit in the action is for.
 */
function MarketingEmailsSwitch() {
  const user = useUser();
  const stored = user.marketingEmails;
  const fetcher = useFetcher<ProfileUpdateResult>();
  const toast = useToast();

  // What the switch shows: the last click. `stored` catches up to it when the
  // write lands and the root loader revalidates.
  const [desired, setDesired] = useState(stored);
  // The value the in-flight write is trying to store, read when it settles.
  const sentRef = useRef(stored);
  const submitSeenRef = useRef(false);
  // `useFetcher` hands back a fresh object every render, so the debounce below
  // can't list it as a dependency without clearing and restarting its timer on
  // each render - it would never fire. Refresh the submit function here instead.
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
    // Put the switch back to what's actually stored. Without this the reconcile
    // below would see a difference it can never close and retry on a loop.
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setDesired(stored);
    // As above: guarded by `submitSeenRef`, so `stored` catching up on
    // revalidation re-runs this to no effect rather than replaying the toast.
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
  const { showThemeSwitcher, sidebarContext, isSsoManaged } = useLoaderData<typeof loader>();
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
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
      setContrastPreview(contrast);
      applyThemeContrast(contrast);
    }
  }, [contrastFetcher.state, contrast]);

  // Dragging previews through the CSS var; releasing (or clicking the default
  // mark) persists it.
  const previewContrast = (value: number) => {
    setContrastPreview(value);
    applyThemeContrast(value);
  };
  const saveContrast = (value: number) =>
    contrastFetcher.submit(
      { action: "update-contrast", contrast: String(value) },
      { method: "post" }
    );

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
                <UserProfilePhoto className="size-8" strokeWidth={1.5} />
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
                <EditEmailButton isSsoManaged={isSsoManaged} />
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
                      text={(value) => themeOptionLabel(value, appearance)}
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
