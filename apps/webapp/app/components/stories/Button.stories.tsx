import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { Button } from "../primitives/Buttons";
import { ArrowLeftIcon } from "@heroicons/react/20/solid";
import { ArrowRightIcon } from "@heroicons/react/20/solid";
import { Header1 } from "../primitives/Headers";
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
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col items-start gap-2">
        <Header1 className="mb-1">Small size</Header1>
        <Button variant="primary/small" text="Primary button" />
        <Button variant="secondary/small" text="Secondary button" />
        <Button variant="tertiary/small" text="Tertiary button" />
        <Button variant="danger/small" text="Danger button" />
      </div>
      <div className="flex flex-col items-start gap-2">
        <Header1 className="mb-1">Medium size</Header1>
        <Button variant="primary/medium" text="Primary button" />
        <Button variant="secondary/medium" text="Secondary button" />
        <Button variant="tertiary/medium" text="Tertiary button" />
        <Button variant="danger/medium" text="Danger button" />
      </div>
      <div className="flex flex-col items-start gap-2">
        <Header1 className="mb-1">Small size, icon left</Header1>
        <Button
          variant="primary/small"
          LeadingIcon={ArrowLeftIcon}
          text="Primary button"
        />
        <Button
          variant="secondary/small"
          LeadingIcon={ArrowLeftIcon}
          text="Secondary button"
        />
        <Button
          variant="tertiary/small"
          LeadingIcon={ArrowLeftIcon}
          text="Tertiary button"
        />
        <Button
          variant="danger/small"
          LeadingIcon={ArrowLeftIcon}
          text="Danger button"
        />
      </div>
      <div className="flex flex-col items-start gap-2">
        <Header1 className="mb-1">Medium size, icon right</Header1>
        <Button
          variant="primary/medium"
          TrailingIcon={ArrowRightIcon}
          text="Primary button"
        />
        <Button
          variant="secondary/medium"
          TrailingIcon={ArrowRightIcon}
          text="Secondary button"
        />
        <Button
          variant="tertiary/medium"
          TrailingIcon={ArrowRightIcon}
          text="Tertiary button"
        />
        <Button
          variant="danger/medium"
          TrailingIcon={ArrowRightIcon}
          text="Danger button"
        />
      </div>
      <div className="flex flex-col items-start gap-2">
        <Header1 className="mb-1">Small size, shortcut</Header1>
        <Button variant="primary/small" text="Primary button" shortcut="⌘S" />
        <Button
          variant="secondary/small"
          text="Secondary button"
          shortcut="⌘S"
        />
        <Button variant="tertiary/small" text="Tertiary button" shortcut="⌘S" />
        <Button variant="danger/small" text="Danger button" shortcut="⌘S" />
      </div>

      <div className="flex flex-col items-start gap-2">
        <Header1 className="mb-1">Medium size, shortcut</Header1>
        <Button variant="primary/medium" text="Primary button" shortcut="⌘S" />
        <Button
          variant="secondary/medium"
          text="Secondary button"
          shortcut="⌘S"
        />
        <Button
          variant="tertiary/medium"
          text="Tertiary button"
          shortcut="⌘S"
        />
        <Button variant="danger/medium" text="Danger button" shortcut="⌘S" />
      </div>
      <div className="flex flex-col items-start gap-2">
        <Header1 className="mb-1">Small size, image icon</Header1>
        <Button
          text="Connect to Slack"
          LeadingIcon="airtable"
          variant="primary/small"
        />
        <Button
          text="Connect to Slack"
          LeadingIcon="github"
          variant="primary/small"
        />
        <Button
          text="Connect to Slack"
          TrailingIcon="github"
          variant="primary/small"
        />
      </div>
    </div>
  );
}
