import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BookOpenIcon,
  ExclamationTriangleIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { AirtableIcon, GitHubLightIcon, SlackIcon } from "@trigger.dev/companyicons";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { Story, StoryGrid, StoryPage, StorySection, StorySubSection } from "../storybook/StoryKit";

/* Driven off the variant list so the page can't drift from the component: every
   family × size combination renders, plus the standalone menu-item variants. */
const FAMILIES = [
  "primary",
  "secondary",
  "tertiary",
  "minimal",
  "danger",
  "warning",
  "docs",
  "ask-trigger",
] as const;

const SIZES = ["small", "medium", "large", "extra-large"] as const;

/** ask-trigger has no extra-large; every other family covers all four sizes. */
function sizesFor(family: (typeof FAMILIES)[number]) {
  return family === "ask-trigger" ? SIZES.filter((s) => s !== "extra-large") : SIZES;
}

type ButtonVariant = Parameters<typeof Button>[0]["variant"];

const MENU_VARIANTS = ["menu-item", "small-menu-item", "small-menu-sub-item"] as const;

export default function Story_() {
  return (
    <StoryPage
      title="Buttons"
      componentNames={["Buttons.tsx"]}
      description="Every variant of Button and LinkButton: all 8 families across all sizes, plus the menu-item variants and every state."
    >
      <StorySection
        title="All families and sizes"
        description="One row per family; a column per size."
      >
        <div className="flex flex-col gap-4">
          {FAMILIES.map((family) => (
            <div key={family} className="rounded-sm border border-grid-dimmed p-3">
              <Paragraph variant="extra-extra-small/caps" className="mb-2 text-text-dimmed">
                {family}
              </Paragraph>
              <div className="flex flex-wrap items-center gap-3">
                {sizesFor(family).map((size) => (
                  <Button key={size} variant={`${family}/${size}` as ButtonVariant}>
                    {size}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </StorySection>

      <StorySection title="Icon-only and menu variants">
        <StoryGrid min="14rem">
          <Story label="secondary/small-icon">
            <Button variant="secondary/small-icon" LeadingIcon={PlusIcon} />
          </Story>
          {MENU_VARIANTS.map((variant) => (
            <Story key={variant} label={variant}>
              <Button variant={variant} LeadingIcon={BookOpenIcon}>
                Menu label
              </Button>
            </Story>
          ))}
        </StoryGrid>
      </StorySection>

      <StorySection
        title="States"
        description="Each family's medium size in every state it can be in."
      >
        <div className="flex flex-col gap-4">
          {(["Default", "Disabled", "Loading", "With shortcut"] as const).map((state) => (
            <StorySubSection key={state} title={state}>
              <div className="flex flex-wrap items-center gap-3 rounded-sm border border-grid-dimmed p-3">
                {FAMILIES.map((family) => (
                  <Button
                    key={family}
                    variant={`${family}/medium` as ButtonVariant}
                    disabled={state === "Disabled"}
                    isLoading={state === "Loading"}
                    shortcut={
                      state === "With shortcut" ? { key: "e", modifiers: ["mod"] } : undefined
                    }
                  >
                    {family}
                  </Button>
                ))}
              </div>
            </StorySubSection>
          ))}
        </div>
      </StorySection>

      <StorySection title="Icons" description="Leading, trailing, both, and brand icons.">
        <StoryGrid min="15rem">
          <Story label="LeadingIcon">
            <Button variant="secondary/medium" LeadingIcon={ArrowLeftIcon}>
              Back
            </Button>
          </Story>
          <Story label="TrailingIcon">
            <Button variant="secondary/medium" TrailingIcon={ArrowRightIcon}>
              Next
            </Button>
          </Story>
          <Story label="Both">
            <Button
              variant="secondary/medium"
              LeadingIcon={ExclamationTriangleIcon}
              TrailingIcon={ArrowRightIcon}
            >
              Review
            </Button>
          </Story>
          <Story label="Danger + icon">
            <Button variant="danger/medium" LeadingIcon={TrashIcon}>
              Delete
            </Button>
          </Story>
          <Story label="Icon only">
            <Button variant="minimal/medium" LeadingIcon={ExclamationTriangleIcon} />
          </Story>
          <Story label="Brand icon (Slack)">
            <Button variant="secondary/medium" LeadingIcon={SlackIcon}>
              Connect to Slack
            </Button>
          </Story>
          <Story label="Brand icon (GitHub)">
            <Button variant="secondary/medium" LeadingIcon={GitHubLightIcon}>
              Connect to GitHub
            </Button>
          </Story>
          <Story label="Brand icon (Airtable)">
            <Button variant="secondary/medium" LeadingIcon={AirtableIcon}>
              Connect to Airtable
            </Button>
          </Story>
          <Story label="Explicit Spinner child">
            <Button
              variant="primary/medium"
              LeadingIcon={<Spinner color="inherit" className="size-4" />}
            >
              Working…
            </Button>
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection title="Layout" description="fullWidth and left-aligned text.">
        <div className="flex max-w-md flex-col gap-3">
          <Button variant="primary/medium" fullWidth>
            fullWidth
          </Button>
          <Button variant="secondary/medium" fullWidth textAlignLeft LeadingIcon={PlusIcon}>
            fullWidth + textAlignLeft
          </Button>
        </div>
      </StorySection>

      <StorySection
        title="LinkButton"
        componentName="Buttons.tsx"
        description="Same variants, rendered as an anchor."
      >
        <StoryGrid min="15rem">
          {(["primary", "secondary", "tertiary", "minimal", "docs"] as const).map((family) => (
            <Story key={family} label={`${family}/medium`}>
              <LinkButton to="/storybook/buttons" variant={`${family}/medium` as ButtonVariant}>
                {family}
              </LinkButton>
            </Story>
          ))}
        </StoryGrid>
      </StorySection>

      <StorySection title="Tooltip" description="Any button can carry a tooltip.">
        <StoryGrid min="15rem">
          <Story label="With tooltip">
            <Button variant="secondary/medium" tooltip="This explains the button">
              Hover me
            </Button>
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}
