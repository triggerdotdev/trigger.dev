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
  return (
    <div className={cn("flex items-center", className)}>
      <PreviousButton cursor={list.pagination.previous} />
      <NextButton cursor={list.pagination.next} />
    </div>
  );
}

function PreviousButton({ cursor }: { cursor?: string }) {
  const path = useCursorPath(cursor, "backward");

  return (
    <div className="peer">
      <LinkButton
        to={path ?? "#"}
        variant={"secondary/small"}
        LeadingIcon={ChevronLeftIcon}
        className={cn(
          "flex items-center rounded-r-none border-r-0 pl-2 pr-[0.5625rem]",
          !path && "cursor-not-allowed opacity-50 group-hover/button:bg-transparent"
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
    <div className="border-l border-charcoal-600 transition peer-hover:border-l peer-hover:border-l-charcoal-550 hover:border-l-charcoal-550">
      <LinkButton
        to={path ?? "#"}
        variant={"secondary/small"}
        TrailingIcon={ChevronRightIcon}
        className={cn(
          "flex items-center rounded-l-none border-l-0 pl-[0.5625rem] pr-2",
          !path && "cursor-not-allowed opacity-50 group-hover/button:bg-transparent"
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
