import { useLocation } from "@remix-run/react";
import { LinkButton } from "~/components/primitives/Buttons";
import { type Direction } from "~/components/runs/RunStatuses";
import { cn } from "~/utils/cn";

type List = {
  pagination: {
    next?: string | undefined;
    previous?: string | undefined;
  };
};

export function ListPagination({ list, className }: { list: List; className?: string }) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <PreviousButton cursor={list.pagination.previous} />
      <NextButton cursor={list.pagination.next} />
    </div>
  );
}

function NextButton({ cursor }: { cursor?: string }) {
  const path = useCursorPath(cursor, "forward");

  return (
    <LinkButton
      to={path ?? "#"}
      variant={"minimal/small"}
      TrailingIcon="arrow-right"
      trailingIconClassName="text-text-dimmed"
      className={cn(
        "flex items-center",
        !path &&
          "cursor-not-allowed opacity-50 group-hover:bg-transparent group-hover:text-text-dimmed"
      )}
      onClick={(e) => !path && e.preventDefault()}
    >
      Next
    </LinkButton>
  );
}

function PreviousButton({ cursor }: { cursor?: string }) {
  const path = useCursorPath(cursor, "backward");

  return (
    <LinkButton
      to={path ?? "#"}
      variant={"minimal/small"}
      LeadingIcon="arrow-left"
      leadingIconClassName="text-text-dimmed"
      className={cn(
        "flex items-center",
        !path &&
          "cursor-not-allowed opacity-50 group-hover:bg-transparent group-hover:text-text-dimmed"
      )}
      onClick={(e) => !path && e.preventDefault()}
    >
      Prev
    </LinkButton>
  );
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
