import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { Badge } from "../primitives/Badge";

const meta: Meta = {
  title: "Primitives/Badges",
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof BadgesExample>;

export const Basic: Story = {
  render: () => <BadgesExample />,
};

function BadgesExample() {
  return (
    <div className="flex flex-col items-start gap-y-8 p-8">
      <Badge>Default</Badge>
      <Badge variant="outline">Outline</Badge>
      <Badge variant="green">Green</Badge>
    </div>
  );
}
