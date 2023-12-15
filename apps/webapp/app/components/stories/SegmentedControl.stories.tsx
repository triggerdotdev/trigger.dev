import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { MainCenteredContainer } from "../layout/AppLayout";
import SegmentedControl from "../primitives/SegmentedControl";

const meta: Meta<typeof StyledSegmentedControl> = {
  title: "Primitives/SegmentedControl",
  decorators: [withDesign],
  component: StyledSegmentedControl,
};

export default meta;

type Story = StoryObj<typeof StyledSegmentedControl>;

export const Basic: Story = {
  render: () => <StyledSegmentedControl />,
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/jBqUJJ2d4lU6aSeKIIOBMY/Trigger.dev?type=design&node-id=2577%3A87576&t=ambgtfvgnwXTHmzI-1",
  },
};

const options = [
  { label: "Label 1", value: "developer" },
  { label: "Label 2", value: "Users" },
];

function StyledSegmentedControl() {
  return (
    <MainCenteredContainer>
      <SegmentedControl name="name" options={options} />
    </MainCenteredContainer>
  );
}
