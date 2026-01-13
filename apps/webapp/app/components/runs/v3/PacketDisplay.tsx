import { CloudArrowDownIcon } from "@heroicons/react/20/solid";
import { CodeBlock } from "~/components/code/CodeBlock";
import { InlineCode } from "~/components/code/InlineCode";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { docsPath } from "~/utils/pathBuilder";

export function PacketDisplay({
  data,
  dataType,
  title,
  searchTerm,
}: {
  data: string;
  dataType: string;
  title: string;
  searchTerm?: string;
}) {
  switch (dataType) {
    case "application/store": {
      return (
        <div className="mt-2 flex flex-col">
          <Header3>{title}</Header3>
          <Paragraph variant="small" className="mb-2">
            This {title.toLowerCase()} exceeded the size limit and was automatically offloaded to
            object storage. You can retrieve it using{" "}
            <InlineCode variant="extra-small">runs.retrieve</InlineCode> or download it directly
            below. <TextLink to={docsPath("limits#task-payloads-and-outputs")}>Learn more</TextLink>
            .
          </Paragraph>
          <div>
            <LinkButton
              LeadingIcon={CloudArrowDownIcon}
              to={data}
              variant="secondary/small"
              download
              className="inline-flex text-text-bright"
            >
              Download {title.toLowerCase()}
            </LinkButton>
          </div>
        </div>
      );
    }
    case "text/plain": {
      return (
        <CodeBlock
          language="markdown"
          rowTitle={title}
          code={data}
          maxLines={20}
          showLineNumbers={false}
          showTextWrapping
          searchTerm={searchTerm}
        />
      );
    }
    default: {
      return (
        <CodeBlock
          language="json"
          rowTitle={title}
          code={data}
          maxLines={20}
          showLineNumbers={false}
          showTextWrapping
          searchTerm={searchTerm}
        />
      );
    }
  }
}
