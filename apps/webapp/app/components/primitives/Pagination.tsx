import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { ChevronLeftIcon } from "@heroicons/react/24/solid";
import { Link, useLocation } from "@remix-run/react";
import { LinkDisabled } from "./LinkWithDisabled";
import { cn } from "~/utils/cn";
import { ButtonContent, LinkButton } from "./Buttons";

export function PaginationControls({
  currentPage,
  totalPages,
}: {
  currentPage: number;
  totalPages: number;
}) {
  const location = useLocation();
  if (totalPages <= 1) {
    return null;
  }

  return (
    <nav className="flex items-center gap-1" aria-label="Pagination">
      <LinkDisabled
        to={pageUrl(location, currentPage - 1)}
        className={currentPage > 1 ? "group" : ""}
        disabled={currentPage === 1}
        disabledClassName="opacity-30 cursor-default"
      >
        <ButtonContent variant="minimal/medium" LeadingIcon={ChevronLeftIcon}>
          Previous
        </ButtonContent>
      </LinkDisabled>

      {calculatePageLinks(currentPage, totalPages).map((page, i) => (
        <PageLinkComponent page={page} key={i} location={location} />
      ))}

      <LinkDisabled
        to={pageUrl(location, currentPage + 1)}
        className={currentPage !== totalPages ? "group" : ""}
        disabled={currentPage === totalPages}
        disabledClassName="opacity-30 cursor-default"
      >
        <ButtonContent variant="minimal/medium" TrailingIcon={ChevronRightIcon}>
          Next
        </ButtonContent>
      </LinkDisabled>
    </nav>
  );
}

function pageUrl(location: ReturnType<typeof useLocation>, page: number): string {
  const search = new URLSearchParams(location.search);

  search.set("page", String(page));

  return location.pathname + "?" + search.toString();
}

const baseClass =
  "flex items-center justify-center border border-transparent h-8 w-8 text-xs font-medium transition text-text-dimmed rounded-sm";
const unselectedClass = "hover:bg-tertiary hover:text-text-bright";
const selectedClass = "border-text-dimmed text-text-bright hover:bg-tertiary";

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
