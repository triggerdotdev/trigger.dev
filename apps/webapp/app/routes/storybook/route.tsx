import { NavLink, Outlet } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useEffect, useRef, useState } from "react";
import { redirect, typedjson, useTypedLoaderData, useTypedRouteLoaderData } from "remix-typedjson";
import { AppContainer } from "~/components/layout/AppLayout";
import { Header2 } from "~/components/primitives/Headers";
import SegmentedControl from "~/components/primitives/SegmentedControl";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { Switch } from "~/components/primitives/Switch";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { type ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";
import { applyThemePreference } from "~/hooks/useSystemThemeSync";
import { type loader as rootLoader } from "~/root";
import { requireUser } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { type ThemePreference } from "~/utils/themePreference";

type Story = {
  name: string;
  slug: string;
};

type StorySection = {
  title: string;
  items: Story[];
};

const sections: StorySection[] = [
  {
    title: "Foundations",
    items: [
      { name: "Colors", slug: "colors" },
      { name: "Typography", slug: "typography" },
      { name: "Icons", slug: "icons" },
      { name: "Avatars", slug: "avatar" },
      { name: "Layout", slug: "layout" },
      { name: "Shortcuts", slug: "shortcuts" },
      { name: "Unordered list", slug: "unordered-list" },
    ],
  },
  {
    title: "Actions",
    items: [
      { name: "Buttons", slug: "buttons" },
      { name: "Segmented control", slug: "segmented-control" },
      { name: "Pagination", slug: "pagination" },
      { name: "Copy & clipboard", slug: "copy" },
      { name: "Clipboard field", slug: "clipboard-field" },
    ],
  },
  {
    title: "Forms",
    items: [
      { name: "Input fields", slug: "input-fields" },
      { name: "Search fields", slug: "search-fields" },
      { name: "Textarea", slug: "textarea" },
      { name: "Checkboxes", slug: "checkboxes" },
      { name: "Radio group", slug: "radio-group" },
      { name: "Switch", slug: "switch" },
      { name: "Slider", slug: "slider" },
      { name: "Stepper", slug: "stepper" },
      { name: "Date fields", slug: "date-fields" },
      { name: "Simple form", slug: "simple-form" },
    ],
  },
  {
    title: "Menus & overlays",
    items: [
      { name: "Select", slug: "select" },
      { name: "Popover", slug: "popover" },
      { name: "Filter", slug: "filter" },
      { name: "Dialog", slug: "dialog" },
      { name: "Sheet", slug: "sheet" },
      { name: "Tooltip", slug: "tooltip" },
    ],
  },
  {
    title: "Feedback",
    items: [
      { name: "Badges", slug: "badges" },
      { name: "Callouts", slug: "callout" },
      { name: "Pricing callout", slug: "pricing-callout" },
      { name: "Info panel", slug: "info-panel" },
      { name: "Toast", slug: "toast" },
      { name: "Spinners", slug: "spinner" },
      { name: "Loading bar divider", slug: "loading-bar-divider" },
      { name: "Free plan usage", slug: "free-plan-usage" },
      { name: "Indicators", slug: "indicators" },
    ],
  },
  {
    title: "Navigation",
    items: [
      { name: "Tabs", slug: "tabs" },
      { name: "Page header", slug: "page-header" },
      { name: "Tree view", slug: "tree-view" },
      { name: "Resizable", slug: "resizable" },
      { name: "Draggable resizable", slug: "draggable-resizable" },
      { name: "Animated panel", slug: "animated-panel" },
      { name: "Accordion", slug: "accordion" },
    ],
  },
  {
    title: "Data display",
    items: [
      { name: "Tables", slug: "table" },
      { name: "Cells & key-value", slug: "detail-cell" },
      { name: "Charts", slug: "charts" },
      { name: "Usage sparkline", slug: "usage" },
      { name: "Timeline", slug: "timeline" },
      { name: "Run & Span timeline", slug: "run-and-span-timeline" },
      { name: "Code block", slug: "code-block" },
      { name: "Inline code", slug: "inline-code" },
      { name: "Streamdown", slug: "streamdown" },
      { name: "TSQL Editor", slug: "tsql-editor" },
    ],
  },
  {
    title: "Runs & logs",
    items: [
      { name: "Run statuses", slug: "run-statuses" },
      { name: "Log levels", slug: "log-levels" },
      { name: "Dates & timers", slug: "dates-timers" },
      { name: "Environment label", slug: "environment-label" },
    ],
  },
  {
    title: "Settings",
    items: [{ name: "Settings rows", slug: "settings-rows" }],
  },
  {
    title: "Trigger Agent",
    items: [
      { name: "Chat UI", slug: "agent-ui" },
      { name: "View blocks", slug: "agent-view-blocks" },
      { name: "Report view", slug: "agent-report" },
      { name: "Investigation card", slug: "agent-investigation" },
      { name: "Watch card", slug: "agent-watch" },
      { name: "Icons & Buttons", slug: "ai-agent" },
    ],
  },
];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  if (!user.admin) {
    throw redirect("/");
  }

  return typedjson({
    sections,
  });
};

const THEME_OPTIONS: { label: string; value: ThemePreference; shortcut: ShortcutDefinition }[] = [
  {
    label: "System",
    value: "system",
    shortcut: { key: "1", modifiers: ["mod"], preventDefault: true },
  },
  {
    label: "Light",
    value: "light",
    shortcut: { key: "2", modifiers: ["mod"], preventDefault: true },
  },
  {
    label: "Dark",
    value: "dark",
    shortcut: { key: "3", modifiers: ["mod"], preventDefault: true },
  },
  {
    label: "White",
    value: "white",
    shortcut: { key: "4", modifiers: ["mod"], preventDefault: true },
  },
  {
    label: "Black",
    value: "black",
    shortcut: { key: "5", modifiers: ["mod"], preventDefault: true },
  },
];

/** Hover hint carrying the theme name and its key, on the standard 500ms delay. */
const TOOLTIP_DELAY_MS = 500;

function ThemeSegmentLabel({ label, shortcut }: { label: string; shortcut: ShortcutDefinition }) {
  return (
    <SimpleTooltip
      button={<span className="px-0.5">{label}</span>}
      content={
        <span className="flex items-center gap-1.5">
          {label}
          <ShortcutKey shortcut={shortcut} variant="small" />
        </span>
      }
      side="bottom"
      delayDuration={TOOLTIP_DELAY_MS}
      disableHoverableContent
      asChild
    />
  );
}

/** Binds one theme's shortcut. Separate component so each gets its own hook. */
function ThemeShortcut({
  shortcut,
  onTrigger,
}: {
  shortcut: ShortcutDefinition;
  onTrigger: () => void;
}) {
  useShortcutKeys({ shortcut, action: onTrigger });
  return null;
}

function useStorybookIconContrast() {
  const rootData = useTypedRouteLoaderData<typeof rootLoader>("root");
  const [iconContrast, setIconContrast] = useState(false);

  const savedIconContrast = useRef(rootData?.iconContrast);
  // oxlint-disable-next-line react/refs -- This ref intentionally coordinates an imperative integration outside React state.
  savedIconContrast.current = rootData?.iconContrast;

  useEffect(() => {
    document.documentElement.setAttribute("data-icon-contrast", iconContrast ? "true" : "false");
  }, [iconContrast]);

  useEffect(() => {
    return () => {
      document.documentElement.setAttribute(
        "data-icon-contrast",
        savedIconContrast.current ? "true" : "false"
      );
    };
  }, []);

  return [iconContrast, setIconContrast] as const;
}

function useStorybookTheme() {
  const rootData = useTypedRouteLoaderData<typeof rootLoader>("root");
  const [theme, setTheme] = useState<ThemePreference>("system");

  // Refs so the unmount restore isn't re-run on data revalidation.
  const savedPreference = useRef(rootData?.themePreference);
  const savedSystemThemes = useRef(rootData?.systemThemes);
  // oxlint-disable-next-line react/refs -- This ref intentionally coordinates an imperative integration outside React state.
  savedPreference.current = rootData?.themePreference;
  // oxlint-disable-next-line react/refs -- This ref intentionally coordinates an imperative integration outside React state.
  savedSystemThemes.current = rootData?.systemThemes;

  const systemThemes = rootData?.systemThemes;
  useEffect(() => {
    applyThemePreference(theme, systemThemes);
  }, [theme, systemThemes]);

  // Leaving the storybook hands the theme back to the account preference.
  useEffect(() => {
    return () => {
      if (savedPreference.current) {
        applyThemePreference(savedPreference.current, savedSystemThemes.current);
      }
    };
  }, []);

  return [theme, setTheme] as const;
}

export default function App() {
  const { sections } = useTypedLoaderData<typeof loader>();
  const [theme, setTheme] = useStorybookTheme();
  const [iconContrast, setIconContrast] = useStorybookIconContrast();

  return (
    <AppContainer>
      {THEME_OPTIONS.map((option) => (
        <ThemeShortcut
          key={option.value}
          shortcut={option.shortcut}
          onTrigger={() => setTheme(option.value)}
        />
      ))}
      <div className="grid grid-cols-[14rem_1fr] overflow-hidden">
        <SideMenu sections={sections} />
        <div className="grid grid-rows-[3rem_1fr] overflow-hidden">
          <div className="flex items-center justify-between gap-4 border-b border-grid-bright bg-background-bright pl-4 pr-2">
            <Header2>Storybook</Header2>
            <div className="flex flex-none items-center gap-3">
              <Switch
                variant="minimal/medium"
                label="Stronger colors"
                checked={iconContrast}
                onCheckedChange={setIconContrast}
              />
              <SegmentedControl
                name="storybook-theme"
                value={theme}
                options={THEME_OPTIONS.map((option) => ({
                  value: option.value,
                  label: <ThemeSegmentLabel label={option.label} shortcut={option.shortcut} />,
                }))}
                variant="secondary/small"
                onChange={(value) => setTheme(value as ThemePreference)}
              />
            </div>
          </div>
          <div className="overflow-y-auto">
            <Outlet />
          </div>
        </div>
      </div>
    </AppContainer>
  );
}

function SideMenu({ sections }: { sections: StorySection[] }) {
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-y-8 overflow-hidden border-r border-grid-bright bg-background-bright px-2 transition"
      )}
    >
      <div className="flex h-full flex-col">
        <div className="h-full overflow-hidden overflow-y-auto pb-8 pt-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
          {sections.map((section) => (
            <div key={section.title}>
              <div className="mx-1 mb-1 mt-4 border-b border-text-dimmed/30 px-1 pb-1 text-xs uppercase text-text-dimmed/60">
                {section.title}
              </div>
              {section.items.map((story) => (
                <NavLink key={story.slug} to={`/storybook/${story.slug}`} className={"text-sm"}>
                  {({ isActive, isPending }) => (
                    <div
                      className={cn(
                        "relative flex items-center gap-2 overflow-hidden truncate rounded-sm px-2 py-2 text-sm text-text-dimmed",
                        (isActive || isPending) && "bg-tertiary text-text-bright"
                      )}
                    >
                      {story.name}
                    </div>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
