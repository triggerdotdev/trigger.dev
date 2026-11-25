import type { ComponentProps } from "react";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";

// Every code sample renders through here.
export function CodeSample(props: ComponentProps<"pre">) {
  return (
    <CodeBlock {...props}>
      <Pre>{props.children}</Pre>
    </CodeBlock>
  );
}
