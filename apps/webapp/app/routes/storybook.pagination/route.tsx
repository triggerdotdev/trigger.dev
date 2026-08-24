import { PaginationControls } from "~/components/primitives/Pagination";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

/* PaginationControls reads ?page from the URL for its links, so the samples
   below navigate this story — which is itself a demonstration. */
export default function Story_() {
  return (
    <StoryPage
      componentNames={["Pagination.tsx"]}
      title="Pagination"
      description="Page controls for list views. The links write ?page to this page's URL."
    >
      <StorySection title="Known page count">
        <StoryGrid min="20rem">
          <Story label="First page of 10">
            <PaginationControls currentPage={1} totalPages={10} />
          </Story>
          <Story label="Mid-range (page 5 of 10)">
            <PaginationControls currentPage={5} totalPages={10} />
          </Story>
          <Story label="Last page of 10">
            <PaginationControls currentPage={10} totalPages={10} />
          </Story>
          <Story label="Many pages (17 of 240)">
            <PaginationControls currentPage={17} totalPages={240} />
          </Story>
          <Story label="Single page → renders nothing">
            <PaginationControls currentPage={1} totalPages={1} />
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection
        title="Unknown page count"
        description="Cursor-style lists pass hasNextPage and hide the numbers."
      >
        <StoryGrid min="20rem">
          <Story label="hasNextPage, page 1">
            <PaginationControls
              currentPage={1}
              totalPages={0}
              hasNextPage
              showPageNumbers={false}
            />
          </Story>
          <Story label="hasNextPage, page 3">
            <PaginationControls
              currentPage={3}
              totalPages={0}
              hasNextPage
              showPageNumbers={false}
            />
          </Story>
          <Story label="Last page (no next)">
            <PaginationControls
              currentPage={3}
              totalPages={0}
              hasNextPage={false}
              showPageNumbers={false}
            />
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}
