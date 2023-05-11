import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { Button } from "../primitives/Buttons";

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
    <div>
      <Button text="Primary button" size="small" theme="primary" />
    </div>
  );
}
