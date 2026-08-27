import { BookOpenIcon, Cog8ToothIcon } from "@heroicons/react/20/solid";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/components/primitives/Accordion";
import { Paragraph } from "~/components/primitives/Paragraph";
import { StoryPage, StorySection } from "../storybook/StoryKit";

export default function Story_() {
  return (
    <StoryPage
      componentNames={["Accordion.tsx"]}
      title="Accordion"
      description="Collapsible sections built on Radix Accordion."
    >
      <StorySection title="Single, collapsible">
        <div className="max-w-xl rounded-sm border border-grid-dimmed p-2">
          <Accordion type="single" collapsible>
            <AccordionItem value="what">
              <AccordionTrigger>What counts as a run?</AccordionTrigger>
              <AccordionContent>
                <Paragraph variant="small">
                  Every task execution is a run, including retries and child tasks triggered from a
                  parent.
                </Paragraph>
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="limits">
              <AccordionTrigger>How do concurrency limits work?</AccordionTrigger>
              <AccordionContent>
                <Paragraph variant="small">
                  Each environment has a concurrency limit; runs beyond it queue until a slot frees
                  up.
                </Paragraph>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </StorySection>

      <StorySection title="Multiple open, with leading icons">
        <div className="max-w-xl rounded-sm border border-grid-dimmed p-2">
          <Accordion type="multiple" defaultValue={["docs"]}>
            <AccordionItem value="docs">
              <AccordionTrigger leadingIcon={BookOpenIcon} leadingIconClassName="text-blue-500">
                Documentation
              </AccordionTrigger>
              <AccordionContent>
                <Paragraph variant="small">Open by default via defaultValue.</Paragraph>
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="settings">
              <AccordionTrigger leadingIcon={Cog8ToothIcon} leadingIconClassName="text-text-dimmed">
                Advanced settings
              </AccordionTrigger>
              <AccordionContent>
                <Paragraph variant="small">
                  Both items can be open at once with type="multiple".
                </Paragraph>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </StorySection>
    </StoryPage>
  );
}
