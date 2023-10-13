import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { SideMenu } from "../navigation/SideMenu";

const meta: Meta<typeof SideMenuV2> = {
  title: "Compound/SideMenu",
  component: SideMenuV2,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof SideMenuV2>;

export const Selects: Story = {
  render: (args) => <SideMenuV2 />,
};

function SideMenuV2() {
  return (
    <div className="h-screen w-full bg-background">
      <div className="grid h-full grid-cols-[220px_auto]">
        <SideMenu />
        <div className="h-full w-full" />
      </div>
    </div>
  );
}
