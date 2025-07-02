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
      variant={"secondary/small"}
      TrailingIcon={ChevronRightIcon}
      className={cn(
        "flex items-center",
        !path && "cursor-not-allowed opacity-50 group-hover/button:bg-transparent"
      )}
      onClick={(e) => !path && e.preventDefault()}
      shortcut={{ key: "k" }}
      tooltip="Next"
      disabled={!path}
    />
  );
}

function PreviousButton({ cursor }: { cursor?: string }) {
  const path = useCursorPath(cursor, "backward");

  return (
    <LinkButton
      to={path ?? "#"}
      variant={"secondary/small"}
      LeadingIcon={ChevronLeftIcon}
      className={cn(
        "flex items-center",
        !path && "cursor-not-allowed opacity-50 group-hover/button:bg-transparent"
      )}
      onClick={(e) => !path && e.preventDefault()}
      shortcut={{ key: "j" }}
      tooltip="Previous"
      disabled={!path}
    />
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
