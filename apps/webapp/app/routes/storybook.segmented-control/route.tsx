import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Paragraph } from "~/components/primitives/Paragraph";
import SegmentedControl from "~/components/primitives/SegmentedControl";

const options = [
  { label: "Label 1", value: "label1" },
  { label: "Label 2", value: "label2" },
];

export default function Story() {
  return (
    <MainCenteredContainer className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Paragraph>primary/small</Paragraph>
        <SegmentedControl
          name="name1"
          defaultValue={options[0].value}
          options={options}
          variant="primary/small"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Paragraph>primary/medium</Paragraph>
        <SegmentedControl
          name="name2"
          defaultValue={options[0].value}
          options={options}
          variant="primary/medium"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Paragraph>secondary/small</Paragraph>
        <SegmentedControl
          name="name3"
          defaultValue={options[0].value}
          options={options}
          variant="secondary/small"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Paragraph>secondary/medium</Paragraph>
        <SegmentedControl
          name="name4"
          defaultValue={options[0].value}
          options={options}
          variant="secondary/medium"
        />
      </div>
    </MainCenteredContainer>
  );
}
