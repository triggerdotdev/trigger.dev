import {
  ArrowLongLeftIcon,
  ArrowLongRightIcon,
} from "@heroicons/react/24/solid";
import { Link, useLocation } from "@remix-run/react";

export function PaginationControls({
  currentPage,
  totalPages,
}: {
  currentPage: number;
  totalPages: number;
}) {
  const location = useLocation();

  return (
    <nav className="flex items-center justify-between border-t border-gray-200 px-4 sm:px-0">
      <div className="-mt-px mr-4 flex w-0 flex-1">
        {currentPage > 1 && (
          <Link
            to={pageUrl(location, currentPage - 1)}
            className="inline-flex items-center border-t-2 border-transparent pt-4 pr-1 text-sm font-medium text-gray-500 hover:border-gray-300 hover:text-gray-700"
          >
            <ArrowLongLeftIcon
              className="mr-3 h-5 w-5 text-gray-400"
              aria-hidden="true"
            />
            Previous
          </Link>
        )}
      </div>
      <div className="hidden md:-mt-px md:flex">
        {calculatePageLinks(currentPage, totalPages).map((page, i) => (
          <PageLinkComponent page={page} key={i} location={location} />
        ))}
      </div>

      <div className="-mt-px flex w-0 flex-1 justify-end">
        {currentPage < totalPages && (
          <Link
            to={pageUrl(location, currentPage + 1)}
            className="inline-flex items-center border-t-2 border-transparent pt-4 pl-1 text-sm font-medium text-gray-500 hover:border-gray-300 hover:text-gray-700"
          >
            Next
            <ArrowLongRightIcon
              className="ml-3 h-5 w-5 text-gray-400"
              aria-hidden="true"
            />
          </Link>
        )}
      </div>
    </nav>
  );
}

function pageUrl(
  location: ReturnType<typeof useLocation>,
  page: number
): string {
  const search = new URLSearchParams(location.search);

  search.set("page", String(page));

  return location.pathname + "?" + search.toString();
}

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
        <Link
          to={pageUrl(location, page.page)}
          className="inline-flex items-center border-t-2 border-indigo-500 px-4 pt-4 text-sm font-medium text-indigo-600"
        >
          {page.page}
        </Link>
      );
    } else {
      return (
        <Link
          to={pageUrl(location, page.page)}
          className="inline-flex items-center border-t-2 border-transparent px-4 pt-4 text-sm font-medium text-gray-500 hover:border-gray-300 hover:text-gray-700"
        >
          {page.page}
        </Link>
      );
    }
  } else {
    return (
      <span className="inline-flex items-center border-t-2 border-transparent px-4 pt-4 text-sm font-medium text-gray-500">
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
function calculatePageLinks(
  currentPage: number,
  totalPages: number
): Array<PageLink> {
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
