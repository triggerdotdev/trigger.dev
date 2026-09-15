import { Button } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "~/components/primitives/SheetV3";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

function DemoSheet({ side }: { side: "top" | "bottom" | "left" | "right" }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="secondary/small">Open {side}</Button>
      </SheetTrigger>
      <SheetContent side={side} className="p-4">
        <SheetHeader>
          <SheetTitle>Sheet from the {side}</SheetTitle>
        </SheetHeader>
        <Paragraph variant="small" className="py-4">
          Sheets host secondary flows that don't warrant a navigation — inspecting a row, editing a
          setting, or a short form.
        </Paragraph>
      </SheetContent>
    </Sheet>
  );
}

export default function Story_() {
  return (
    <StoryPage
      componentNames={["SheetV3.tsx"]}
      title="Sheet"
      description="Slide-over panels (SheetV3) from each edge, with header, description and footer."
    >
      <StorySection title="Sides">
        <StoryGrid min="13rem">
          <Story label="Right (default)">
            <DemoSheet side="right" />
          </Story>
          <Story label="Left">
            <DemoSheet side="left" />
          </Story>
          <Story label="Top">
            <DemoSheet side="top" />
          </Story>
          <Story label="Bottom">
            <DemoSheet side="bottom" />
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}
