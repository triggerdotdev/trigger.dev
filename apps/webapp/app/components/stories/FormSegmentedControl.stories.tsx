import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import FormSegmentedControl from "../primitives/FormSegmentedControl";
import { MainCenteredContainer } from "../layout/AppLayout";

const meta: Meta = {
  title: "Primitives/FormSegmentedControl",
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof FormSegmentedControl>;

export const Basic: Story = {
  render: () => <SegmentedControl />,
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

function SegmentedControl() {
  return (
    <MainCenteredContainer>
      <FormSegmentedControl name="name" options={options} />
    </MainCenteredContainer>
  );
}
