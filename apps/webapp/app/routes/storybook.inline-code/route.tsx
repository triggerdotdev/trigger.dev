import { InlineCode } from "~/components/code/InlineCode";
import { Paragraph } from "~/components/primitives/Paragraph";

export default function Story() {
  return (
    <div className="grid h-full place-content-center">
      <Paragraph>
        You should use <InlineCode>id: my-first-job</InlineCode> when you want to achieve this.
      </Paragraph>
    </div>
  );
}
