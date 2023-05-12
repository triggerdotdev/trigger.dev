import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { Button } from "../primitives/Buttons";
import {
  ArrowLeftIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/20/solid";
import { ArrowRightIcon } from "@heroicons/react/20/solid";
import { Header1 } from "../primitives/Headers";
import { NamedIcon } from "../primitives/NamedIcon";
import {
  ExclamationCircleIcon,
  LightBulbIcon,
  ServerIcon,
} from "@heroicons/react/24/solid";

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
  return (
    <div className="flex gap-24 p-8">
      <div className="flex flex-col gap-8">
        <div className="flex flex-col items-start gap-2">
          <Header1 className="mb-1">Small size</Header1>
          <Button variant="primary/small" children="Primary button" />
          <Button variant="secondary/small" children="Secondary button" />
          <Button variant="tertiary/small" children="Tertiary button" />
          <Button variant="danger/small" children="Danger button" />
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header1 className="mb-1">Small size, icon left</Header1>
          <Button
            variant="primary/small"
            LeadingIcon={ArrowLeftIcon}
            children="Primary button"
          />
          <Button
            variant="secondary/small"
            LeadingIcon={ArrowLeftIcon}
            children="Secondary button"
          />
          <Button
            variant="tertiary/small"
            LeadingIcon={ArrowLeftIcon}
            children="Tertiary button"
          />
          <Button
            variant="danger/small"
            LeadingIcon={ArrowLeftIcon}
            children="Danger button"
          />
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header1 className="mb-1">Small size, icon right</Header1>
          <Button
            variant="primary/small"
            TrailingIcon={ArrowRightIcon}
            children="Primary button"
          />
          <Button
            variant="secondary/small"
            TrailingIcon={ArrowRightIcon}
            children="Secondary button"
          />
          <Button
            variant="tertiary/small"
            trailingIconClassName="text-red-500"
            TrailingIcon={ArrowRightIcon}
            children="Tertiary button"
          />
          <Button
            variant="danger/small"
            TrailingIcon={ArrowRightIcon}
            children="Danger button"
          />
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header1 className="mb-1">Small size, shortcut</Header1>
          <Button
            variant="primary/small"
            children="Primary button"
            shortcut="⌘S"
          />
          <Button
            variant="secondary/small"
            children="Secondary button"
            shortcut="⌘S"
          />
          <Button
            variant="tertiary/small"
            children="Tertiary button"
            shortcut="⌘S"
          />
          <Button
            variant="danger/small"
            children="Danger button"
            shortcut="⌘S"
          />
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header1 className="mb-1">Small size, image icon</Header1>
          <Button
            children="Connect to Slack"
            LeadingIcon="airtable"
            variant="primary/small"
          />
          <Button
            children="Connect to Slack"
            LeadingIcon="github"
            variant="primary/small"
          />
          <Button
            children="Connect to Slack"
            TrailingIcon="slack"
            variant="primary/small"
          />
        </div>
      </div>
      <div className="flex flex-col gap-8">
        <div className="flex flex-col items-start gap-2">
          <Header1 className="mb-1">Medium size</Header1>
          <Button variant="primary/medium" children="Primary button" />
          <Button variant="secondary/medium" children="Secondary button" />
          <Button variant="tertiary/medium" children="Tertiary button" />
          <Button variant="danger/medium" children="Danger button" />
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header1 className="mb-1">Medium size, icon left</Header1>
          <Button
            variant="primary/medium"
            LeadingIcon={ArrowLeftIcon}
            children="Primary button"
          />
          <Button
            variant="secondary/medium"
            LeadingIcon={ArrowLeftIcon}
            children="Secondary button"
          />
          <Button
            variant="tertiary/medium"
            LeadingIcon={ArrowLeftIcon}
            children="Tertiary button"
          />
          <Button
            variant="danger/medium"
            LeadingIcon={ArrowLeftIcon}
            children="Danger button"
          />
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header1 className="mb-1">Medium size, icon right</Header1>
          <Button
            variant="primary/medium"
            TrailingIcon={ArrowRightIcon}
            children="Primary button"
          />
          <Button
            variant="secondary/medium"
            TrailingIcon={ArrowRightIcon}
            children="Secondary button"
          />
          <Button
            variant="tertiary/medium"
            TrailingIcon={ArrowRightIcon}
            children="Tertiary button"
          />
          <Button
            variant="danger/medium"
            TrailingIcon={ArrowRightIcon}
            children="Danger button"
          />
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header1 className="mb-1">Medium size, shortcut</Header1>
          <Button
            variant="primary/medium"
            children="Primary button"
            shortcut="⌘S"
          />
          <Button
            variant="secondary/medium"
            children="Secondary button"
            shortcut="⌘S"
          />
          <Button
            variant="tertiary/medium"
            children="Tertiary button"
            shortcut="⌘S"
          />
          <Button
            variant="danger/medium"
            children="Danger button"
            shortcut="⌘S"
          />
        </div>
        <div className="flex flex-col items-start gap-2">
          <Header1 className="mb-1">Medium size, named icon</Header1>
          <Button
            children="Connect to Slack"
            LeadingIcon="airtable"
            variant="primary/medium"
          />
          <Button
            children="Connect to Slack"
            LeadingIcon="github"
            variant="primary/medium"
          />
          <Button
            children="Connect to Slack"
            TrailingIcon="slack"
            variant="primary/medium"
          />
          <Button
            children="Connect to Slack"
            LeadingIcon="warning"
            variant="primary/medium"
          />
        </div>
      </div>
      <div className="flex flex-col items-start gap-2">
        <Header1 className="mb-1">Icon only</Header1>
        <Button variant="primary/small" LeadingIcon={ArrowRightIcon} />
        <Button variant="secondary/small" LeadingIcon={LightBulbIcon} />
        <Button variant="tertiary/small" LeadingIcon={ServerIcon} />
        <Button variant="danger/small" LeadingIcon={ExclamationTriangleIcon} />
        <Button variant="primary/medium" LeadingIcon={ArrowRightIcon} />
        <Button variant="secondary/medium" LeadingIcon={LightBulbIcon} />
        <Button variant="tertiary/medium" LeadingIcon={ServerIcon} />
        <Button variant="danger/medium" LeadingIcon={ExclamationTriangleIcon} />
      </div>
    </div>
  );
}
