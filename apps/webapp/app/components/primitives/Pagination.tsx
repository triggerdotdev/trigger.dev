import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { ChevronLeftIcon } from "@heroicons/react/24/solid";
import { Link, useLocation } from "@remix-run/react";
import { cn } from "~/utils/cn";
import { LinkButton } from "./Buttons";

/** Pass `hasNextPage` when the total page count is unknown; use `showPageNumbers={false}` in that case. */
export function PaginationControls({
  currentPage,
  totalPages,
  hasNextPage,
  showPageNumbers = true,
  shortcuts = true,
}: {
  currentPage: number;
  totalPages: number;
  /** When set, navigation uses this instead of `totalPages`. */
  hasNextPage?: boolean;
  showPageNumbers?: boolean;
  /** Disable on duplicate controls so keyboard navigation only fires once. */
  shortcuts?: boolean;
}) {
  const location = useLocation();
  const hasNextMode = hasNextPage !== undefined;
  const showPagination = hasNextMode ? currentPage > 1 || hasNextPage : totalPages > 1;
  const nextDisabled = hasNextMode ? !hasNextPage : currentPage === totalPages;

  if (!showPagination) {
    return null;
  }

  return (
    <nav className="flex items-center gap-1" aria-label="Pagination">
      {showPageNumbers ? (
        <>
          <LinkButton
            to={pageUrl(location, currentPage - 1)}
            variant="secondary/small"
            LeadingIcon={ChevronLeftIcon}
            shortcut={shortcuts ? { key: "j" } : undefined}
            tooltip="Previous"
            disabled={currentPage === 1}
            className={cn("px-2", currentPage > 1 ? "group" : "")}
          />

          {calculatePageLinks(currentPage, totalPages).map((page, i) => (
            <PageLinkComponent page={page} key={i} location={location} />
          ))}

          <LinkButton
            to={pageUrl(location, currentPage + 1)}
            variant="secondary/small"
            TrailingIcon={ChevronRightIcon}
            shortcut={shortcuts ? { key: "k" } : undefined}
            tooltip="Next"
            disabled={nextDisabled}
            className={cn("px-2", !nextDisabled ? "group" : "")}
          />
        </>
      ) : (
        <div className="flex items-center">
          <div className={cn("peer/prev order-1", currentPage === 1 && "pointer-events-none")}>
            <LinkButton
              to={pageUrl(location, currentPage - 1)}
              variant="secondary/small"
              LeadingIcon={ChevronLeftIcon}
              shortcut={shortcuts ? { key: "j" } : undefined}
              tooltip="Previous"
              disabled={currentPage === 1}
              className={cn(
                "flex items-center rounded-r-none border-r-0 pl-2 pr-2.25",
                currentPage === 1 && "cursor-not-allowed opacity-50"
              )}
            />
          </div>

          <div
            className={cn(
              "order-2 h-6 w-px bg-surface-control transition-colors peer-hover/next:bg-surface-control-hover peer-hover/prev:bg-surface-control-hover",
              currentPage === 1 && nextDisabled && "opacity-30"
            )}
          />

          <div className={cn("peer/next order-3", nextDisabled && "pointer-events-none")}>
            <LinkButton
              to={pageUrl(location, currentPage + 1)}
              variant="secondary/small"
              TrailingIcon={ChevronRightIcon}
              shortcut={shortcuts ? { key: "k" } : undefined}
              tooltip="Next"
              disabled={nextDisabled}
              className={cn(
                "flex items-center rounded-l-none border-l-0 pl-2.25 pr-2",
                nextDisabled && "cursor-not-allowed opacity-50"
              )}
            />
          </div>
        </div>
      )}
    </nav>
  );
}

function pageUrl(location: ReturnType<typeof useLocation>, page: number): string {
  const search = new URLSearchParams(location.search);

  search.set("page", String(page));

  return location.pathname + "?" + search.toString();
}

const baseClass =
  "flex items-center justify-center border border-transparent min-w-6 h-6 px-1 text-xs font-medium transition text-text-dimmed rounded-sm focus-visible:focus-custom";
const unselectedClass = "hover:bg-tertiary hover:text-text-bright";
const selectedClass =
  "border-border-bright bg-tertiary text-text-bright hover:bg-surface-control/50";

function PageLinkComponent({
  page,
  location,
}: {
  page: PageLink;
  location: ReturnType<typeof useLocation>;
}) {
  if (page.type === "specific") {
    return (
      <Link
        to={pageUrl(location, page.page)}
        className={cn(baseClass, page.isCurrent ? selectedClass : unselectedClass)}
      >
        {page.page}
      </Link>
    );
  } else {
    return <span className={baseClass}>...</span>;
  }
}

type PageLink = EllipsisPageLink | SpecificPageLink;

type EllipsisPageLink = {
  type: "ellipses";
};

type SpecificPageLink = {
  type: "specific";
  page: number;
  isCurrent: boolean;
};

// Up to 10 pages: show them all. More: the first and last few, plus the current page and its
// neighbours. "…" only stands in for 2+ hidden pages; a single hidden page is shown instead.
export function calculatePageLinks(currentPage: number, totalPages: number): Array<PageLink> {
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);

  const pages =
    totalPages <= 10
      ? range(1, totalPages)
      : currentPage <= 3
        ? [...range(1, 4), ...range(totalPages - 3, totalPages)]
        : currentPage >= totalPages - 3
          ? [...range(1, 3), ...range(totalPages - 4, totalPages)]
          : [
              ...range(1, 3),
              ...range(currentPage - 1, currentPage + 1),
              ...range(totalPages - 2, totalPages),
            ];

  const pageLinks: Array<PageLink> = [];
  let previous = 0;
  for (const page of [...new Set(pages)].sort((a, b) => a - b)) {
    if (page - previous === 2) {
      pageLinks.push({ type: "specific", page: previous + 1, isCurrent: false });
    } else if (page - previous > 2) {
      pageLinks.push({ type: "ellipses" });
    }
    pageLinks.push({ type: "specific", page, isCurrent: page === currentPage });
    previous = page;
  }

  return pageLinks;
}
