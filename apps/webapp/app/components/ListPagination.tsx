import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
import { useLocation } from "@remix-run/react";
import { z } from "zod";
import { LinkButton } from "~/components/primitives/Buttons";
import { cn } from "~/utils/cn";

type List = {
  pagination: {
    next?: string | undefined;
    previous?: string | undefined;
  };
};

export const DirectionSchema = z.union([z.literal("forward"), z.literal("backward")]);
export type Direction = z.infer<typeof DirectionSchema>;

export function ListPagination({ list, className }: { list: List; className?: string }) {
  const bothDisabled = !list.pagination.previous && !list.pagination.next;

  return (
    <div className={cn("flex items-center", className)}>
      <PreviousButton cursor={list.pagination.previous} />
      <NextButton cursor={list.pagination.next} />
      <div
        className={cn(
          "order-2 h-6 w-px bg-charcoal-600 transition-colors peer-hover/next:bg-charcoal-550 peer-hover/prev:bg-charcoal-550",
          bothDisabled && "opacity-30"
        )}
      />
    </div>
  );
}

function PreviousButton({ cursor }: { cursor?: string }) {
  const path = useCursorPath(cursor, "backward");

  return (
    <div className={cn("peer/prev order-1", !path && "pointer-events-none")}>
      <LinkButton
        to={path ?? "#"}
        variant={"secondary/small"}
        LeadingIcon={ChevronLeftIcon}
        className={cn(
          "flex items-center rounded-r-none border-r-0 pl-2 pr-[0.5625rem]",
          !path && "cursor-not-allowed opacity-50"
        )}
        onClick={(e) => !path && e.preventDefault()}
        shortcut={{ key: "j" }}
        tooltip="Previous"
        disabled={!path}
      />
    </div>
  );
}

function NextButton({ cursor }: { cursor?: string }) {
  const path = useCursorPath(cursor, "forward");

  return (
    <div className={cn("peer/next order-3", !path && "pointer-events-none")}>
      <LinkButton
        to={path ?? "#"}
        variant={"secondary/small"}
        TrailingIcon={ChevronRightIcon}
        className={cn(
          "flex items-center rounded-l-none border-l-0 pl-[0.5625rem] pr-2",
          !path && "cursor-not-allowed opacity-50"
        )}
        onClick={(e) => !path && e.preventDefault()}
        shortcut={{ key: "k" }}
        tooltip="Next"
        disabled={!path}
      />
    </div>
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
