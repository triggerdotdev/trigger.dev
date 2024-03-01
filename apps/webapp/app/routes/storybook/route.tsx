import { NavLink, Outlet } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Fragment } from "react";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { AppContainer } from "~/components/layout/AppLayout";
import { env } from "~/env.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";

const stories: Story[] = [
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
    name: "Free plan usage",
    slug: "free-plan-usage",
  },
  {
    name: "Inline code",
    slug: "inline-code",
  },
  {
    name: "Typography",
    slug: "typography",
  },
  {
    sectionTitle: "Forms",
    name: "Simple form",
    slug: "simple-form",
  },
  {
    name: "Login form",
    slug: "login-form",
  },
  {
    name: "Search fields",
    slug: "search-fields",
  },
  {
    name: "Input fields",
    slug: "input-fields",
  },
];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await requireUserId(request);

  console.log("ENV", env.NODE_ENV);

  if (env.NODE_ENV !== "development") {
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
