import { NavLink, Outlet } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { AppContainer } from "~/components/layout/AppLayout";
import { RadioButtonCircle } from "~/components/primitives/RadioButton";
import { env } from "~/env.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";

const stories: Story[] = [
  {
    name: "Buttons",
    slug: "buttons",
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
          {stories.map((story) => (
            <NavLink key={story.slug} to={`/storybook/${story.slug}`} className={"text-sm"}>
              {({ isActive, isPending }) => (
                <div
                  className={cn(
                    "relative flex items-center gap-2 overflow-hidden truncate rounded-sm px-2 py-2",
                    (isActive || isPending) && "z-20 outline outline-1 outline-indigo-500"
                  )}
                >
                  <RadioButtonCircle checked={isActive || isPending} />
                  <div className="flex w-full items-center justify-between gap-2">{story.name}</div>
                </div>
              )}
            </NavLink>
          ))}
        </div>
      </div>
    </div>
  );
}
