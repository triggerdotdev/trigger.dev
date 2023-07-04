import { useNavigation } from "@remix-run/react";
import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { HowToRunYourJob } from "~/components/helpContent/HelpContentText";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { RunsTable } from "~/components/runs/RunsTable";
import { RunListPresenter } from "~/presenters/RunListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { Handle } from "~/utils/handle";
import { JobParamsSchema } from "~/utils/pathBuilder";
import { ListPagination } from "./ListPagination";

export const DirectionSchema = z.union([
  z.literal("forward"),
  z.literal("backward"),
]);

const SearchSchema = z.object({
  cursor: z.string().optional(),
  direction: DirectionSchema.optional(),
});

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { jobParam, projectParam, organizationSlug } =
    JobParamsSchema.parse(params);

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const searchParams = SearchSchema.parse(s);

  const presenter = new RunListPresenter();
  const list = await presenter.call({
    userId,
    jobSlug: jobParam,
    projectSlug: projectParam,
    organizationSlug,
    direction: searchParams.direction,
    cursor: searchParams.cursor,
  });

  return typedjson({
    list,
  });
};

export const handle: Handle = {
  breadcrumb: {
    slug: "runs",
  },
};

export default function Page() {
  const { list } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  return (
    <Help defaultOpen={list.runs.length === 0}>
      {(open) => (
        <div
          className={cn(
            "grid h-fit gap-4",
            open ? "grid-cols-2" : "grid-cols-1"
          )}
        >
          <div>
            <div className="mb-2 flex items-center justify-end gap-x-2">
              <ListPagination list={list} />
              <HelpTrigger title="How do I run my Job?" />
            </div>
            <RunsTable
              total={list.runs.length}
              hasFilters={false}
              runs={list.runs}
              isLoading={isLoading}
            />
            <ListPagination list={list} className="mt-2 justify-end" />
          </div>
          <HelpContent title="How to run your Job">
            <HowToRunYourJob />
          </HelpContent>
        </div>
      )}
    </Help>
  );
}
