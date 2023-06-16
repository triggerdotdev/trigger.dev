import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { ClipboardField } from "../ClipboardField";

const meta: Meta = {
  title: "Primitives/ClipboardField",
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof ClipboardFieldExample>;

export const Basic: Story = {
  render: () => <ClipboardFieldExample />,
};

function ClipboardFieldExample() {
  return (
    <div className="flex gap-8">
      <div className="flex flex-col items-start gap-y-8 p-8">
        <ClipboardField value="copy paste me" variant="primary/small" />
        <ClipboardField value="copy paste me" variant="secondary/small" />
        <ClipboardField value="copy paste me" variant="tertiary/small" />
        <ClipboardField value="copy paste me" variant="primary/medium" />
        <ClipboardField value="copy paste me" variant="secondary/medium" />
      </div>
      <div className="flex flex-col items-start gap-y-8 p-8">
        <ClipboardField
          value="copy paste me"
          variant="primary/small"
          secure={true}
        />
        <ClipboardField
          value="copy paste me"
          variant="secondary/small"
          secure={true}
        />
        <ClipboardField
          value="copy paste me"
          variant="primary/medium"
          secure={true}
        />
        <ClipboardField
          value="copy paste me"
          variant="secondary/medium"
          secure={true}
        />
      </div>
    </div>
  );
}
