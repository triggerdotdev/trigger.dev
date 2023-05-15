import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { NamedIcon, iconNames } from "../primitives/NamedIcon";

const meta: Meta<typeof NamedIcons> = {
  title: "Icons",
  // @ts-ignore
  component: NamedIcons,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof NamedIcons>;

export const Basic: Story = {
  args: {
    // @ts-ignore
    appear: true,
    show: true,
    title: "NamedIcons Title",
  },
  render: (args) => <NamedIcons />,
};

function NamedIcons() {
  return (
    <div className="grid grid-cols-8 gap-4">
      {iconNames
        .sort((a, b) => a.localeCompare(b))
        .map((iconName) => (
          <div key={iconName} className="flex items-center gap-2">
            <div>
              <NamedIcon name={iconName} className={"h-6 w-6"} />
            </div>
            <span className="text-xs text-dimmed">{iconName}</span>
          </div>
        ))}
    </div>
  );
}
