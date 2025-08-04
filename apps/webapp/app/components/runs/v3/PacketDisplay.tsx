import { CloudArrowDownIcon } from "@heroicons/react/20/solid";
import { CodeBlock } from "~/components/code/CodeBlock";
import { LinkButton } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";

export function PacketDisplay({
  data,
  dataType,
  title,
}: {
  data: string;
  dataType: string;
  title: string;
}) {
  switch (dataType) {
    case "application/store": {
      return (
        <div className="flex flex-col">
          <Paragraph variant="base/bright" className="w-full py-2.5 text-sm">
            {title}
          </Paragraph>
          <LinkButton LeadingIcon={CloudArrowDownIcon} to={data} variant="tertiary/medium" download>
            Download
          </LinkButton>
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
        />
      );
    }
  }
}
