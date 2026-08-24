import { LightBulbIcon } from "@heroicons/react/20/solid";
import { ClipboardIcon } from "lucide-react";
import { Button } from "~/components/primitives/Buttons";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import {
  InfoIconTooltip,
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

const SIDES = ["top", "right", "bottom", "left"] as const;

export default function Story_() {
  return (
    <StoryPage
      title="Tooltip"
      componentNames={["Tooltip.tsx"]}
      description="Both tooltip variants, every side, and the delay options. Hover each sample."
    >
      <StorySection title="Variants" description="basic (default) and dark.">
        <StoryGrid min="15rem">
          <Story label="basic">
            <SimpleTooltip
              button={<Button variant="secondary/small">Hover</Button>}
              content="Basic variant"
              asChild
            />
          </Story>
          <Story label="dark">
            <SimpleTooltip
              button={<Button variant="secondary/small">Hover</Button>}
              content="Dark variant"
              variant="dark"
              asChild
            />
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection title="Sides">
        <StoryGrid min="12rem">
          {SIDES.map((side) => (
            <Story key={side} label={side}>
              <SimpleTooltip
                button={<Button variant="secondary/small">{side}</Button>}
                content={`Opens ${side}`}
                side={side}
                asChild
              />
            </Story>
          ))}
        </StoryGrid>
      </StorySection>

      <StorySection title="Delay" description="delayDuration in ms before the tooltip appears.">
        <StoryGrid min="12rem">
          {[0, 250, 500, 1000].map((delay) => (
            <Story key={delay} label={`${delay}ms`}>
              <SimpleTooltip
                button={<Button variant="secondary/small">{delay}ms</Button>}
                content={`Appeared after ${delay}ms`}
                delayDuration={delay}
                asChild
              />
            </Story>
          ))}
        </StoryGrid>
      </StorySection>

      <StorySection title="Rich content" description="Composed with the low-level parts.">
        <StoryGrid min="15rem">
          <Story label="Icon + text">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <ClipboardIcon className="size-5" />
                </TooltipTrigger>
                <TooltipContent className="flex items-center gap-1">
                  <LightBulbIcon className="size-4 text-yellow-400" />
                  Copy
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </Story>
          <Story label="With a shortcut key">
            <SimpleTooltip
              button={<Button variant="secondary/small">Save</Button>}
              content={
                <span className="flex items-center gap-1.5">
                  Save
                  <ShortcutKey shortcut={{ key: "s", modifiers: ["mod"] }} variant="small" />
                </span>
              }
              asChild
            />
          </Story>
          <Story label="disableHoverableContent">
            <SimpleTooltip
              button={<Button variant="secondary/small">Hover</Button>}
              content="You can't hover into this one"
              disableHoverableContent
              asChild
            />
          </Story>
          <Story label="InfoIconTooltip">
            <InfoIconTooltip content="The little ⓘ used beside labels and table headers." />
          </Story>
          <Story label="InfoIconTooltip (dark)">
            <InfoIconTooltip content="Dark variant" variant="dark" />
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}
