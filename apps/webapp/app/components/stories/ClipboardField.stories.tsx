import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { ClipboardField } from "../primitives/ClipboardField";
import { EnvironmentLabel } from "../environments/EnvironmentLabel";

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
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/small"
          icon={<EnvironmentLabel environment={{ type: "PRODUCTION" }} />}
        />
        <ClipboardField value="with leadingIcon" variant="tertiary/small" icon="search" />
        <ClipboardField value="copy paste me" variant="primary/medium" />
        <ClipboardField value="copy paste me" variant="secondary/medium" />
        <ClipboardField value="copy paste me" variant="tertiary/medium" />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/medium"
          icon={<EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />}
        />
        <ClipboardField value="with leadingIcon" variant="tertiary/medium" icon="search" />
      </div>
      <div className="flex flex-col items-start gap-y-8 p-8">
        <ClipboardField value="copy paste me" variant="primary/small" secure={true} />
        <ClipboardField value="copy paste me" variant="secondary/small" secure={true} />
        <ClipboardField value="copy paste me" variant="tertiary/small" secure={true} />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/small"
          icon={<EnvironmentLabel environment={{ type: "STAGING" }} />}
          secure={true}
        />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/small"
          icon="search"
          secure={true}
        />
        <ClipboardField value="copy paste me" variant="primary/medium" secure={true} />
        <ClipboardField value="copy paste me" variant="secondary/medium" secure={true} />
        <ClipboardField value="copy paste me" variant="tertiary/medium" secure={true} />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/medium"
          icon={<EnvironmentLabel environment={{ type: "PRODUCTION" }} />}
          secure={true}
        />
        <ClipboardField
          value="with leadingIcon"
          variant="tertiary/medium"
          icon="search"
          secure={true}
        />
      </div>
      <div className="flex flex-col items-start gap-y-8 p-8">
        <ClipboardField value="npx abcdefghi" variant="primary/small" secure="npx ••••••••" />
        <ClipboardField value="npx abcdefghi" variant="secondary/small" secure="npx ••••••••" />
        <ClipboardField value="npx abcdefghi" variant="tertiary/small" secure="npx ••••••••" />
        <ClipboardField
          value="npx abcdefghi"
          variant="tertiary/small"
          icon={<EnvironmentLabel environment={{ type: "STAGING" }} />}
          secure="npx ••••••••"
        />
        <ClipboardField
          value="npx abcdefghi"
          variant="tertiary/small"
          icon="search"
          secure="npx ••••••••"
        />
        <ClipboardField value="npx abcdefghi" variant="primary/medium" secure="npx ••••••••" />
        <ClipboardField value="npx abcdefghi" variant="secondary/medium" secure="npx ••••••••" />
        <ClipboardField value="npx abcdefghi" variant="tertiary/medium" secure="npx ••••••••" />
        <ClipboardField
          value="npx abcdefghi"
          variant="tertiary/medium"
          icon={<EnvironmentLabel environment={{ type: "PRODUCTION" }} />}
          secure="npx ••••••••"
        />
        <ClipboardField
          value="npx abcdefghi"
          variant="tertiary/medium"
          icon="search"
          secure="npx ••••••••"
        />
      </div>
    </div>
  );
}
