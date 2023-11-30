import { useLocation } from "@remix-run/react";
import { LinkButton } from "~/components/primitives/Buttons";
import { Direction, RunList } from "~/presenters/RunListPresenter.server";
import { WebhookDeliveryList } from "~/presenters/WebhookDeliveryListPresenter.server";
import { cn } from "~/utils/cn";

export function ListPagination({
  list,
  className,
}: {
  list: RunList | WebhookDeliveryList;
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

  return (
    <LinkButton
      to={path ?? "#"}
      variant={"tertiary/small"}
      TrailingIcon="chevron-right"
      className={cn(
        "flex items-center",
        !path && "cursor-default opacity-50 group-hover:bg-transparent group-hover:text-slate-800"
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
      variant={"tertiary/small"}
      LeadingIcon="chevron-left"
      className={cn(
        "flex items-center",
        !path && "cursor-default opacity-50 group-hover:bg-transparent group-hover:text-slate-800"
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
