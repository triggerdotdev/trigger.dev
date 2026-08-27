import { BookOpenIcon, Cog8ToothIcon, PlusIcon } from "@heroicons/react/20/solid";
import { type ReactNode, useState } from "react";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverCustomTrigger,
  PopoverEllipseTrigger,
  PopoverMenuItem,
  PopoverSectionHeader,
  PopoverTrigger,
  PopoverVerticalEllipseTrigger,
} from "~/components/primitives/Popover";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

const ARROW_VARIANTS = ["minimal", "primary", "secondary", "tertiary"] as const;

function MenuBody() {
  return (
    <>
      <PopoverSectionHeader title="Section header" />
      <div className="flex flex-col gap-1 p-1">
        <PopoverMenuItem to="#" title="Menu item" icon={BookOpenIcon} />
        <PopoverMenuItem to="#" title="Selected item" icon={Cog8ToothIcon} isSelected />
        <PopoverMenuItem to="#" title="Another item" icon={PlusIcon} />
      </div>
      <div className="border-t border-grid-bright p-1">
        <PopoverMenuItem to="#" title="Footer item" icon={PlusIcon} />
      </div>
    </>
  );
}

/** Each sample owns its open state so the triggers can show their open styling. */
function PopoverSample({ children }: { children: (isOpen: boolean) => ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <Popover onOpenChange={setIsOpen} open={isOpen}>
      {children(isOpen)}
      <PopoverContent className="min-w-[16rem] overflow-y-auto p-0" align="start">
        <MenuBody />
      </PopoverContent>
    </Popover>
  );
}

export default function Story_() {
  return (
    <StoryPage
      title="Popover"
      componentNames={["Popover.tsx"]}
      description="Every trigger style and every menu part. Click a trigger to open it."
    >
      <StorySection
        title="PopoverArrowTrigger"
        description="All four variants, plus the layout options."
      >
        <StoryGrid min="15rem">
          {ARROW_VARIANTS.map((variant) => (
            <Story key={variant} label={variant}>
              <PopoverSample>
                {(isOpen) => (
                  <PopoverArrowTrigger isOpen={isOpen} variant={variant}>
                    {variant}
                  </PopoverArrowTrigger>
                )}
              </PopoverSample>
            </Story>
          ))}
          <Story label="fullWidth">
            <PopoverSample>
              {(isOpen) => (
                <PopoverArrowTrigger isOpen={isOpen} fullWidth>
                  Full width trigger
                </PopoverArrowTrigger>
              )}
            </PopoverSample>
          </Story>
          <Story label="overflowHidden (long label)">
            <PopoverSample>
              {(isOpen) => (
                <PopoverArrowTrigger isOpen={isOpen} overflowHidden>
                  A label long enough that it has to truncate inside the trigger
                </PopoverArrowTrigger>
              )}
            </PopoverSample>
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection title="Other triggers">
        <StoryGrid min="15rem">
          <Story label="PopoverTrigger">
            <PopoverSample>{() => <PopoverTrigger>Open menu</PopoverTrigger>}</PopoverSample>
          </Story>
          <Story label="PopoverCustomTrigger">
            <PopoverSample>
              {() => (
                // The trigger is itself a button, so its child is content.
                <PopoverCustomTrigger
                  aria-label="Custom trigger"
                  className="gap-1.5 px-2 py-1 text-sm"
                >
                  <Cog8ToothIcon className="size-4" />
                  Custom trigger
                </PopoverCustomTrigger>
              )}
            </PopoverSample>
          </Story>
          <Story label="PopoverVerticalEllipseTrigger">
            <PopoverSample>
              {(isOpen) => <PopoverVerticalEllipseTrigger isOpen={isOpen} />}
            </PopoverSample>
          </Story>
          <Story label="PopoverEllipseTrigger (vertical)">
            <PopoverSample>
              {(isOpen) => <PopoverEllipseTrigger isOpen={isOpen} orientation="vertical" />}
            </PopoverSample>
          </Story>
          <Story label="PopoverEllipseTrigger (horizontal)">
            <PopoverSample>
              {(isOpen) => <PopoverEllipseTrigger isOpen={isOpen} orientation="horizontal" />}
            </PopoverSample>
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection title="Content placement" description="side, as passed to PopoverContent.">
        <StoryGrid min="15rem">
          {(["top", "right", "bottom", "left"] as const).map((side) => (
            <Story key={side} label={`side="${side}"`}>
              <Popover>
                <PopoverTrigger>{side}</PopoverTrigger>
                <PopoverContent side={side} className="min-w-[12rem] p-2">
                  <Paragraph variant="extra-small">Opens to the {side}.</Paragraph>
                </PopoverContent>
              </Popover>
            </Story>
          ))}
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}
