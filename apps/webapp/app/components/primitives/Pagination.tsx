import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { ChevronLeftIcon } from "@heroicons/react/24/solid";
import { Link, useLocation } from "@remix-run/react";
import { LinkDisabled } from "./LinkWithDisabled";
import { cn } from "~/utils/cn";

export function PaginationControls({
  currentPage,
  totalPages,
  pageSize,
  totalResults,
}: {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalResults: number;
}) {
  const location = useLocation();
  if (totalPages <= 1) {
    return null;
  }

  return (
    <div className="flex items-center justify-between rounded-b-lg border-t border-charcoal-850 bg-charcoal-700/20 py-3 pl-4 pr-3 text-charcoal-400">
      <div className="flex flex-1 justify-between sm:hidden">
        {currentPage > 1 && (
          <Link
            to={pageUrl(location, currentPage - 1)}
            className="hover:bg-charcoal-50 relative inline-flex items-center rounded-md border border-charcoal-300 bg-charcoal-700/20 px-4 py-2 text-xs"
          >
            Previous
          </Link>
        )}
        {currentPage < totalPages && (
          <Link
            to={pageUrl(location, currentPage + 1)}
            className="hover:bg-charcoal-50 relative ml-3 inline-flex items-center rounded-md border border-charcoal-300 bg-charcoal-700/20 px-4 py-2 text-xs"
          >
            Next
          </Link>
        )}
      </div>
      <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-charcoal-400">
            Showing <span className="font-medium">{(currentPage - 1) * pageSize + 1}</span> to{" "}
            <span className="font-medium">{currentPage * pageSize}</span> of{" "}
            <span className="font-medium">{totalResults}</span> results
          </p>
        </div>
        <div>
          <nav
            className="isolate inline-flex -space-x-px rounded-md shadow-sm"
            aria-label="Pagination"
          >
            <LinkDisabled
              to={pageUrl(location, currentPage - 1)}
              disabled={currentPage === 1}
              className="relative inline-flex items-center rounded-l border border-charcoal-500 bg-charcoal-700/20 px-2 text-xs font-medium text-charcoal-400 transition hover:border-charcoal-400 hover:bg-charcoal-400 hover:text-charcoal-800 focus:z-20"
              disabledClassName="opacity-30 cursor-default hover:bg-charcoal-700/20 hover:border-charcoal-500 hover:!text-charcoal-400"
            >
              <span className="sr-only">Previous</span>
              <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
            </LinkDisabled>

            {calculatePageLinks(currentPage, totalPages).map((page, i) => (
              <PageLinkComponent page={page} key={i} location={location} />
            ))}

            <LinkDisabled
              to={pageUrl(location, currentPage + 1)}
              disabled={currentPage === totalPages}
              className="relative inline-flex items-center rounded-r border border-charcoal-500 bg-charcoal-700/20 px-2 text-xs font-medium text-charcoal-400 transition hover:border-charcoal-400 hover:bg-charcoal-400 hover:text-charcoal-800 focus:z-20"
              disabledClassName="opacity-30 cursor-default hover:bg-charcoal-700/20 hover:border-charcoal-500 hover:!text-charcoal-400"
            >
              <span className="sr-only">Next</span>
              <ChevronRightIcon className="h-4 w-4" aria-hidden="true" />
            </LinkDisabled>
          </nav>
        </div>
      </div>
    </div>
  );
}

function pageUrl(location: ReturnType<typeof useLocation>, page: number): string {
  const search = new URLSearchParams(location.search);

  search.set("page", String(page));

  return location.pathname + "?" + search.toString();
}

const baseClass =
  "relative inline-flex items-center border px-3.5 py-2 text-xs font-medium focus:z-20 transition";
const unselectedClass =
  "bg-charcoal-700/20 border-charcoal-500 text-charcoal-400 hover:bg-charcoal-400 hover:text-charcoal-900";
const selectedClass =
  "z-10 bg-charcoal-500 border-charcoal-500 hover:bg-charcoal-400 text-charcoal-900";

function PageLinkComponent({
  page,
  location,
}: {
  page: PageLink;
  location: ReturnType<typeof useLocation>;
}) {
  if (page.type === "specific") {
    if (page.isCurrent) {
      return (
        <Link to={pageUrl(location, page.page)} className={cn(baseClass, selectedClass)}>
          {page.page}
        </Link>
      );
    } else {
      return (
        <Link to={pageUrl(location, page.page)} className={cn(baseClass, unselectedClass)}>
          {page.page}
        </Link>
      );
    }
  } else {
    return (
      <span className="inline-flex items-center border-t-2 border-transparent px-4 pt-4 text-xs font-medium text-charcoal-500">
        ...
      </span>
    );
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

// If there are less than or equal to 6 pages, just show all the pages.
// If there are more than 5 pages, show the first 3, the current page, and the last 3.
function calculatePageLinks(currentPage: number, totalPages: number): Array<PageLink> {
  const pageLinks: Array<PageLink> = [];

  if (totalPages <= 10) {
    for (let i = 1; i <= totalPages; i++) {
      pageLinks.push({
        type: "specific",
        page: i,
        isCurrent: i === currentPage,
      });
    }
  } else {
    if (currentPage <= 3) {
      for (let i = 1; i <= 4; i++) {
        pageLinks.push({
          type: "specific",
          page: i,
          isCurrent: i === currentPage,
        });
      }

      pageLinks.push({
        type: "ellipses",
      });

      for (let i = totalPages - 3; i <= totalPages; i++) {
        pageLinks.push({
          type: "specific",
          page: i,
          isCurrent: i === currentPage,
        });
      }
    } else if (currentPage >= totalPages - 3) {
      for (let i = 1; i <= 3; i++) {
        pageLinks.push({
          type: "specific",
          page: i,
          isCurrent: i === currentPage,
        });
      }

      pageLinks.push({
        type: "ellipses",
      });

      for (let i = totalPages - 4; i <= totalPages; i++) {
        pageLinks.push({
          type: "specific",
          page: i,
          isCurrent: i === currentPage,
        });
      }
    } else {
      for (let i = 1; i <= 3; i++) {
        pageLinks.push({
          type: "specific",
          page: i,
          isCurrent: i === currentPage,
        });
      }

      pageLinks.push({
        type: "ellipses",
      });

      for (let i = currentPage - 1; i <= currentPage + 1; i++) {
        pageLinks.push({
          type: "specific",
          page: i,
          isCurrent: i === currentPage,
        });
      }

      pageLinks.push({
        type: "ellipses",
      });

      for (let i = totalPages - 2; i <= totalPages; i++) {
        pageLinks.push({
          type: "specific",
          page: i,
          isCurrent: i === currentPage,
        });
      }
    }
  }

  return pageLinks;
}
