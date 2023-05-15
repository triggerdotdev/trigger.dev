import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { Header1, Header2, Header3 } from "../primitives/Headers";
import { Paragraph, TextLink } from "../primitives/Paragraph";

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
    <div className="flex flex-col gap-8">
      <div>
        <Header1>{header1}</Header1>
        <Header1 variant="dimmed">{header1}</Header1>
        <Header2>{header2}</Header2>
        <Header3>{header3}</Header3>
        <Paragraph>{paragraph}</Paragraph>
        <Paragraph variant="base/bright">{paragraph}</Paragraph>
        <Paragraph variant="small">{paragraph}</Paragraph>
        <Paragraph variant="small/bright">{paragraph}</Paragraph>
        <Paragraph variant="extra-small">{paragraph}</Paragraph>
        <Paragraph variant="extra-small/bright">{paragraph}</Paragraph>
        <Paragraph variant="extra-small/mono">{paragraph}</Paragraph>
        <Paragraph variant="extra-small/bright/mono">{paragraph}</Paragraph>
        <Paragraph variant="extra-small/caps">{paragraph}</Paragraph>
        <Paragraph variant="extra-small/bright/caps">{paragraph}</Paragraph>
        <Paragraph variant="extra-extra-small">{paragraph}</Paragraph>
        <Paragraph variant="extra-extra-small/bright">{paragraph}</Paragraph>
        <Paragraph variant="extra-extra-small/caps">{paragraph}</Paragraph>
        <Paragraph variant="extra-extra-small/bright/caps">
          {paragraph}
        </Paragraph>
      </div>
      <div>
        <Header2>Text Link</Header2>
        <Paragraph>
          This is an <TextLink href="#">anchor tag component</TextLink> called
          TextLink. It takes an href and children.
        </Paragraph>
        <Paragraph>
          Learn how to get started quickly using the included some example Jobs
          which are great as a quick start project. You can check them out in
          your project here in triggerdotdev/jobs/examples. You can also see the
          examples in more detail in the docs.
        </Paragraph>
      </div>
      <div>
        <Header2>Custom event JSON payload</Header2>
        <Paragraph>
          Write your Job code. Jobs can be triggered on a schedule, via a
          webhook, custom event and have delays of up to 1 year. Learn how to
          create your first Job in code using the docs here.
        </Paragraph>
        <Paragraph>
          Learn how to get started quickly using the included some example Jobs
          which are great as a quick start project. You can check them out in
          your project here in triggerdotdev/jobs/examples. You can also see the
          examples in more detail in the docs.
        </Paragraph>
      </div>
      <div>
        <Header2>Scopes</Header2>
        <Paragraph variant="small">
          Select the scopes you want to grant to Slack in order for it to access
          your data. If you try and perform an action in a Job that requires a
          scope you haven’t granted, that task will fail.
        </Paragraph>
        <Paragraph variant="small">
          Select the scopes you want to grant to Slack in order for it to access
          your data. If you try and perform an action in a Job that requires a
          scope you haven’t granted, that task will fail.
        </Paragraph>
      </div>
    </div>
  );
}
