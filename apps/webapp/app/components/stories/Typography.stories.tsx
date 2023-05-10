import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { Header1, Header2, Header3 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";

const meta: Meta<typeof Typography> = {
  title: "Primitives/Typography",
  component: Typography,
  decorators: [withDesign],
};

export default meta;

type Story = StoryObj<typeof Typography>;

export const Basic: Story = {
  args: {
    header1: "Header 1 text",
    header2: "Header 2 text",
    header3: "Header 3 text",
    paragraph: "Paragraph text",
  },

  render: (args) => <Typography {...args} />,
};

Basic.parameters = {
  design: {
    type: "figma",
    url: "https://www.figma.com/file/jBqUJJ2d4lU6aSeKIIOBMY/Trigger.dev?type=design&node-id=2182%3A44955&t=ufnsmP3ns5zCviTT-1",
  },
};

type TypographyProps = {
  header1: string;
  header2: string;
  header3: string;
  paragraph: string;
};

function Typography({ header1, header2, header3, paragraph }: TypographyProps) {
  return (
    <div>
      <Header1>{header1}</Header1>
      <Header1 variant="dimmed">{header1}</Header1>
      <Header2>{header2}</Header2>
      <Header3>{header3}</Header3>
      <Paragraph>{paragraph}</Paragraph>
      <Paragraph variant="base/dimmed">{paragraph}</Paragraph>
      <Paragraph variant="small">{paragraph}</Paragraph>
      <Paragraph variant="small/dimmed">{paragraph}</Paragraph>
      <Paragraph variant="extra-small">{paragraph}</Paragraph>
      <Paragraph variant="extra-small/dimmed">{paragraph}</Paragraph>
      <Paragraph variant="extra-small/mono">{paragraph}</Paragraph>
      <Paragraph variant="extra-small/dimmed/mono">{paragraph}</Paragraph>
      <Paragraph variant="extra-small/caps">{paragraph}</Paragraph>
      <Paragraph variant="extra-small/dimmed/caps">{paragraph}</Paragraph>
      <Paragraph variant="extra-extra-small/caps">{paragraph}</Paragraph>
      <Paragraph variant="extra-extra-small/dimmed/caps">{paragraph}</Paragraph>
    </div>
  );
}
