import { ArrowTopRightOnSquareIcon } from "@heroicons/react/20/solid";
import { Header1, Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";

type TypographyProps = {
  header1: string;
  header2: string;
  header3: string;
  paragraph: string;
};

export default function Story({
  header1 = "This is a Header 1",
  header2 = "This is a Header 2",
  header3 = "This is a Header 3",
  paragraph = "This is paragraph text",
}: TypographyProps) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Header1>{header1}</Header1>
        <Header1 textColor="dimmed">{header1}</Header1>
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
        <Paragraph variant="extra-extra-small/bright/caps">{paragraph}</Paragraph>
      </div>
      <div>
        <Header2>Text Link</Header2>
        <Paragraph>
          This is an <TextLink href="#">anchor tag component</TextLink> called TextLink. It takes an
          href and children.
        </Paragraph>
        <Paragraph>
          Learn how to get{" "}
          <TextLink href="#" trailingIcon={ArrowTopRightOnSquareIcon}>
            started quickly
          </TextLink>{" "}
          using the included some example Jobs which are great as a quick start project. You can
          check them out in your project here in triggerdotdev/jobs/examples. You can also see the
          examples in more detail in the docs.
        </Paragraph>
      </div>
      <div>
        <Header2>Custom event JSON payload</Header2>
        <Paragraph>
          Write your Job code. Jobs can be triggered on a schedule, via a webhook, custom event and
          have delays of up to 1 year. Learn how to create your first Job in code using the docs
          here.
        </Paragraph>
        <Paragraph>
          Learn how to get started quickly using the included some example Jobs which are great as a
          quick start project. You can check them out in your project here in
          triggerdotdev/jobs/examples. You can also see the examples in more detail in the docs.
        </Paragraph>
      </div>
      <div>
        <Header2>Scopes</Header2>
        <Paragraph variant="small">
          Select the scopes you want to grant to Slack in order for it to access your data. If you
          try and perform an action in a Job that requires a scope you haven’t granted, that task
          will fail.
        </Paragraph>
        <Paragraph variant="small">
          Select the scopes you want to grant to Slack in order for it to access your data. If you
          try and perform an action in a Job that requires a scope you haven’t granted, that task
          will fail.
        </Paragraph>
      </div>
    </div>
  );
}
