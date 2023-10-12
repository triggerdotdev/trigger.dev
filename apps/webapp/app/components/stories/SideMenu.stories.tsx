import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";

const meta: Meta<typeof SelectMenu> = {
  title: "Primitives/Menus",
  component: SelectMenu,
  decorators: [withDesign],
  tags: ["autodocs"],
};

export default meta;

type Story = StoryObj<typeof SelectMenu>;

export const Selects: Story = {
  render: (args) => <SelectMenu />,
};

function SelectMenu() {
  return <div>sdfsdf</div>;
}
