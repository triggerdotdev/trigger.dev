import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/20/solid";
import { ArrowUturnLeftIcon, LightBulbIcon } from "@heroicons/react/24/solid";
import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { Button } from "../primitives/Buttons";
import { Header1, Header3 } from "../primitives/Headers";
import { NamedIcon } from "../primitives/NamedIcon";

const meta: Meta<typeof ButtonList> = {
  title: "Primitives/Buttons",
  component: ButtonList,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof ButtonList>;

export const Basic: Story = {
  args: {
    primary: "Primary button",
  },

  render: (args) => <ButtonList {...args} />,
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/jBqUJJ2d4lU6aSeKIIOBMY/Trigger.dev?type=design&node-id=1759%3A2827&t=e3AwZEA5bMHRVjFb-1",
  },
};

function ButtonList({ primary }: { primary: string }) {
  const isSelected = true;
  return (
    <div>
      <Header1 className="mb-2">Small buttons</Header1>
      <div className="grid grid-cols-6">
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Basic</Header3>
          <Button variant="primary/small">Primary button</Button>
          <Button variant="secondary/small">Secondary button</Button>
          <Button variant="tertiary/small">Tertiary button</Button>
          <Button variant="danger/small">Danger button</Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Icon left</Header3>
          <Button variant="primary/small" LeadingIcon={ArrowLeftIcon}>
            Primary button
          </Button>
          <Button variant="secondary/small" LeadingIcon={ArrowLeftIcon}>
            Secondary button
          </Button>
          <Button variant="tertiary/small" LeadingIcon={ArrowLeftIcon}>
            Tertiary button
          </Button>
          <Button variant="danger/small" LeadingIcon={ArrowLeftIcon}>
            Danger button
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Icon right</Header3>
          <Button variant="primary/small" TrailingIcon={ArrowRightIcon}>
            Primary button
          </Button>
          <Button variant="secondary/small" TrailingIcon={ArrowRightIcon}>
            Secondary button
          </Button>
          <Button variant="tertiary/small" TrailingIcon={ArrowRightIcon}>
            Tertiary button
          </Button>
          <Button variant="danger/small" TrailingIcon={ArrowRightIcon}>
            Danger button
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Shortcut</Header3>
          <Button variant="primary/small" shortcut="⌘S">
            Primary button
          </Button>
          <Button variant="secondary/small" shortcut="K">
            Secondary button
          </Button>
          <Button variant="tertiary/small" shortcut="⌘S">
            Tertiary button
          </Button>
          <Button variant="danger/small" shortcut="⌘S">
            Danger button
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Named icon</Header3>
          <Button LeadingIcon="airtable" variant="primary/small">
            Connect to Airtable
          </Button>
          <Button LeadingIcon="github" variant="primary/small">
            Connect to GitHub
          </Button>
          <Button TrailingIcon="slack" variant="secondary/small">
            Connect to Slack
          </Button>
          <Button TrailingIcon="warning" variant="secondary/small">
            Connect to Slack
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Icon only</Header3>
          <Button variant="primary/small" LeadingIcon={ArrowRightIcon} />
          <Button variant="secondary/small" LeadingIcon={LightBulbIcon} />
          <Button variant="tertiary/small" LeadingIcon="warning" />
          <Button
            variant="danger/small"
            LeadingIcon={ExclamationTriangleIcon}
          />
        </div>
      </div>
      <Header1 className="mb-2 mt-6">Medium buttons</Header1>
      <div className="grid grid-cols-6">
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Basic</Header3>
          <Button variant="primary/medium">Primary button</Button>
          <Button variant="secondary/medium">Secondary button</Button>
          <Button variant="tertiary/medium">Tertiary button</Button>
          <Button variant="danger/medium">Danger button</Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Icon left</Header3>
          <Button variant="primary/medium" LeadingIcon={ArrowLeftIcon}>
            Primary button
          </Button>
          <Button variant="secondary/medium" LeadingIcon={ArrowLeftIcon}>
            Secondary button
          </Button>
          <Button variant="tertiary/medium" LeadingIcon={ArrowLeftIcon}>
            Tertiary button
          </Button>
          <Button variant="danger/medium" LeadingIcon={ArrowLeftIcon}>
            Danger button
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Icon right</Header3>
          <Button variant="primary/medium" TrailingIcon={ArrowRightIcon}>
            Primary button
          </Button>
          <Button variant="secondary/medium" TrailingIcon={ArrowRightIcon}>
            Secondary button
          </Button>
          <Button variant="tertiary/medium" TrailingIcon={ArrowRightIcon}>
            Tertiary button
          </Button>
          <Button variant="danger/medium" TrailingIcon={ArrowRightIcon}>
            Danger button
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Shortcut</Header3>
          <Button variant="primary/medium" shortcut="⌘S">
            Primary button
          </Button>
          <Button variant="secondary/medium" shortcut="F">
            Secondary button
          </Button>
          <Button variant="tertiary/medium" shortcut="⌘S">
            Tertiary button
          </Button>
          <Button variant="danger/medium" shortcut="⌘S">
            Danger button
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Named icon</Header3>
          <Button LeadingIcon="airtable" variant="primary/medium">
            Connect to Airtable
          </Button>
          <Button LeadingIcon="github" variant="primary/medium">
            Connect to GitHub
          </Button>
          <Button TrailingIcon="slack" variant="primary/medium">
            Connect to Slack
          </Button>
          <Button LeadingIcon="warning" variant="primary/medium">
            Connect to Slack
          </Button>
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header3 className="mb-1 uppercase">Icon only</Header3>
          <Button variant="primary/medium" LeadingIcon={ArrowRightIcon} />
          <Button variant="secondary/medium" LeadingIcon={LightBulbIcon} />
          <Button variant="tertiary/medium" LeadingIcon="warning" />
          <Button
            variant="danger/medium"
            LeadingIcon={ExclamationTriangleIcon}
          />
        </div>
      </div>
      <Header1 className="mb-2 mt-6">Large buttons</Header1>
      <div className="grid grid-cols-1 gap-2">
        <div className="flex flex-col items-start">
          <Button variant="primary/large" fullWidth>
            <NamedIcon name={"github"} className={"mr-1.5 h-4 w-4"} />
            Continue with GitHub
          </Button>
        </div>
        <div className="flex flex-col items-start">
          <Button variant="secondary/large" fullWidth>
            <NamedIcon
              name={"envelope"}
              className={"mr-1.5 h-4 w-4 transition group-hover:text-bright"}
            />
            Continue with Email
          </Button>
        </div>
      </div>
      <Header1 className="mb-2 mt-6">Menu items</Header1>
      <div className="grid grid-cols-1">
        <div className="flex flex-col items-start gap-1 rounded border border-slate-800 bg-slate-850 p-1">
          <Button
            variant="menu-item"
            fullWidth
            textAlignLeft
            LeadingIcon="folder"
          >
            Acme Inc.
          </Button>
          <Button
            variant="menu-item"
            fullWidth
            textAlignLeft
            LeadingIcon="plus"
          >
            New Project
          </Button>
          <Button
            variant="menu-item"
            fullWidth
            textAlignLeft
            LeadingIcon="globe"
            TrailingIcon={isSelected ? "check" : undefined}
            className={
              isSelected ? "bg-slate-750 group-hover:bg-slate-750" : undefined
            }
          >
            Item selected
          </Button>
          <Button
            variant="menu-item"
            fullWidth
            textAlignLeft
            LeadingIcon="slack"
          >
            When a Stripe payment fails re-engage the customer
          </Button>
          <Button
            variant="menu-item"
            fullWidth
            textAlignLeft
            LeadingIcon={ArrowUturnLeftIcon}
            leadingIconClassName="text-dimmed"
          >
            Latest run payload
          </Button>
        </div>
      </div>
    </div>
  );
}
