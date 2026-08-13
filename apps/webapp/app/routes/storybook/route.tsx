import { NavLink, Outlet } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useEffect, useRef, useState } from "react";
import { redirect, typedjson, useTypedLoaderData, useTypedRouteLoaderData } from "remix-typedjson";
import { AppContainer } from "~/components/layout/AppLayout";
import { Paragraph } from "~/components/primitives/Paragraph";
import SegmentedControl from "~/components/primitives/SegmentedControl";
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
      { name: "Theme tokens", slug: "theme-tokens" },
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

/* The storybook's theme is its own, so components can be checked in every theme
   without touching the account preference. Default is System. */
const THEME_SEGMENTS: { label: string; value: ThemePreference }[] = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
  { label: "White", value: "white" },
  { label: "Black", value: "black" },
];

function useStorybookTheme() {
  const rootData = useTypedRouteLoaderData<typeof rootLoader>("root");
  const [theme, setTheme] = useState<ThemePreference>("system");

  // Refs so the unmount cleanup restores whatever the account preference is by
  // then, without re-running the restore on data revalidation.
  const savedPreference = useRef(rootData?.themePreference);
  const savedSystemThemes = useRef(rootData?.systemThemes);
  savedPreference.current = rootData?.themePreference;
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

  return (
    <AppContainer>
      <div className="grid grid-cols-[14rem_1fr] overflow-hidden">
        <SideMenu sections={sections} />
        <div className="grid grid-rows-[2.75rem_1fr] overflow-hidden">
          <div className="flex items-center justify-between border-b border-grid-bright bg-background-bright pl-4 pr-2">
            <Paragraph variant="extra-small" className="text-text-dimmed">
              Storybook
            </Paragraph>
            <SegmentedControl
              name="storybook-theme"
              value={theme}
              options={THEME_SEGMENTS}
              variant="secondary/small"
              onChange={(value) => setTheme(value as ThemePreference)}
            />
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
