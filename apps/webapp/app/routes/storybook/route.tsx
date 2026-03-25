import { NavLink, Outlet } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Fragment } from "react";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { AppContainer } from "~/components/layout/AppLayout";
import { env } from "~/env.server";
import { requireUser } from "~/services/session.server";
import { cn } from "~/utils/cn";

const stories: Story[] = [
  {
    name: "Avatar",
    slug: "avatar",
  },
  {
    name: "Badges",
    slug: "badges",
  },
  {
    name: "Buttons",
    slug: "buttons",
  },
  {
    name: "Callouts",
    slug: "callout",
  },
  {
    name: "Charts",
    slug: "charts",
  },
  {
    name: "Checkboxes",
    slug: "checkboxes",
  },
  {
    name: "Clipboard field",
    slug: "clipboard-field",
  },
  {
    name: "Code block",
    slug: "code-block",
  },
  {
    name: "Detail cell",
    slug: "detail-cell",
  },
  {
    name: "Dialog",
    slug: "dialog",
  },
  {
    name: "Environment label",
    slug: "environment-label",
  },
  {
    name: "Free plan usage",
    slug: "free-plan-usage",
  },
  {
    name: "Info panel",
    slug: "info-panel",
  },
  {
    name: "Inline code",
    slug: "inline-code",
  },
  {
    name: "Loading bar divider",
    slug: "loading-bar-divider",
  },
  {
    name: "Page header",
    slug: "page-header",
  },
  {
    name: "Pricing callout",
    slug: "pricing-callout",
  },
  {
    name: "Radio group",
    slug: "radio-group",
  },
  {
    name: "Resizable",
    slug: "resizable",
  },
  {
    name: "Run & Span timeline",
    slug: "run-and-span-timeline",
  },
  {
    name: "Segemented control",
    slug: "segmented-control",
  },
  {
    name: "Shortcuts",
    slug: "shortcuts",
  },
  {
    name: "Spinners",
    slug: "spinner",
  },
  {
    name: "Switch",
    slug: "switch",
  },
  {
    name: "Tables",
    slug: "table",
  },
  {
    name: "Tabs",
    slug: "tabs",
  },
  {
    name: "Timeline",
    slug: "timeline",
  },
  {
    name: "Toast",
    slug: "toast",
  },
  {
    name: "Tooltip",
    slug: "tooltip",
  },
  {
    name: "Tree view",
    slug: "tree-view",
  },
  {
    name: "TSQL Editor",
    slug: "tsql-editor",
  },
  {
    name: "Typography",
    slug: "typography",
  },
  {
    name: "Usage",
    slug: "usage",
  },
  // Forms section
  {
    sectionTitle: "Forms",
    name: "Date fields",
    slug: "date-fields",
  },
  {
    name: "Input fields",
    slug: "input-fields",
  },
  {
    name: "Search fields",
    slug: "search-fields",
  },
  {
    name: "Simple form",
    slug: "simple-form",
  },
  {
    name: "Stepper",
    slug: "stepper",
  },
  {
    name: "Textarea",
    slug: "textarea",
  },
  // Menus section
  {
    sectionTitle: "Menus",
    name: "Filter",
    slug: "filter",
  },
  {
    name: "Popover",
    slug: "popover",
  },
  {
    name: "Select",
    slug: "select",
  },
];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);

  if (!user.admin) {
    throw redirect("/");
  }

  return typedjson({
    stories,
  });
};

export default function App() {
  const { stories } = useTypedLoaderData<typeof loader>();

  return (
    <AppContainer>
      <div className="grid grid-cols-[14rem_1fr] overflow-hidden">
        <SideMenu stories={stories} />
        <div className="overflow-y-auto">
          <Outlet />
        </div>
      </div>
    </AppContainer>
  );
}

type Story = {
  name: string;
  slug: string;
  sectionTitle?: string;
};

function SideMenu({ stories }: { stories: Story[] }) {
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-y-8 overflow-hidden border-r border-grid-bright bg-background-bright px-2 transition"
      )}
    >
      <div className="flex h-full flex-col">
        <div className="h-full overflow-hidden overflow-y-auto pt-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
          {stories.map((story) => {
            return (
              <Fragment key={story.slug}>
                {story.sectionTitle && (
                  <div className="mx-1 mb-1 mt-4 border-b border-text-dimmed/30 px-1 pb-1 text-xs uppercase text-text-dimmed/60">
                    {story.sectionTitle}
                  </div>
                )}
                <NavLink to={`/storybook/${story.slug}`} className={"text-sm"}>
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
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
