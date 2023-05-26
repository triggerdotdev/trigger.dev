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

function ListPagination({
  list,
  className,
}: {
  list: RunList;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <PreviousButton cursor={list.pagination.previous} />
      <NextButton cursor={list.pagination.next} />
    </div>
  );
}

function NextButton({ cursor }: { cursor?: string }) {
  const path = useCursorPath(cursor, "forward");

  return path ? (
    <LinkButton
      to={path}
      variant={"secondary/small"}
      TrailingIcon="chevron-right"
    >
      <span className="sr-only">Next</span>
    </LinkButton>
  ) : null;
}

function PreviousButton({ cursor }: { cursor?: string }) {
  const path = useCursorPath(cursor, "backward");

  return path ? (
    <LinkButton
      to={path}
      variant={"secondary/small"}
      LeadingIcon="chevron-left"
    >
      <span className="sr-only">Previous</span>
    </LinkButton>
  ) : null;
}

function useCursorPath(cursor: string | undefined, direction: Direction) {
  const location = useLocation();

  if (!cursor) {
    return undefined;
  }

  const search = new URLSearchParams(location.search);
  search.set("cursor", cursor);
  search.set("direction", direction);
  return location.pathname + "?" + search.toString();
}
