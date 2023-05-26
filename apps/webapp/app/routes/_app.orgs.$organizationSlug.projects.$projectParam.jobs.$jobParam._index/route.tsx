import { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { RunsTable } from "~/components/runs/RunsTable";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  Direction,
  DirectionSchema,
  RunList,
  RunListPresenter,
} from "~/presenters/RunListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import { z } from "zod";
import { useLocation } from "@remix-run/react";
import { LinkButton } from "~/components/primitives/Buttons";
import { cn } from "~/utils/cn";
import { ListPagination } from "./ListPagination";

//todo defer the run list query
//todo live show when there are new items in the list

const SearchSchema = z.object({
  cursor: z.string().optional(),
  direction: DirectionSchema.optional(),
});

export const loader = async ({ request, params }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const { jobParam } = params;
  invariant(jobParam, "jobParam not found");

  const url = new URL(request.url);
  const searchParams = SearchSchema.parse(
    Object.fromEntries(url.searchParams.entries())
  );

  const presenter = new RunListPresenter();
  const list = await presenter.call({
    userId,
    jobId: jobParam,
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

  return (
    <div>
      <ListPagination list={list} className="mb-1 justify-end" />
      <RunsTable total={10} hasFilters={false} runs={list.runs} />
      <ListPagination list={list} className="mb-1 justify-end" />
    </div>
  );
}
