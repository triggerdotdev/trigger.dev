import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { CodeBlock } from "../code/CodeBlock";

const meta: Meta<typeof CodeBlock> = {
  title: "CodeBlock",
  component: CodeBlock,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof CodeBlock>;

export const Basic: Story = {
  args: {
    code: `export const client = new TriggerClient("smoke-test", {
  apiUrl: "http://localhost:3000",
  endpoint: "http://localhost:3007/__trigger/entry",
  logLevel: "debug",
  longLine: "This is a long line that will scroll off the edge of the screen and cause a horizontal scrollbar",
  onLog: (log) => {
    console.log(log);
  },
  onLogError: (log) => {
    console.error(log);
  },
  onLogWarning: (log) => {
    console.warn(log);
  },
  onLogInfo: (log) => {
    console.info(log);
  },
});`,
    highlightLines: [2],
  },

  render: (args) => <CodeBlock {...args} />,
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/LKQ4FJ4bTnCSjedbRpk931/Sample-File",
  },
};
