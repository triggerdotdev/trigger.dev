import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Paragraph } from "~/components/primitives/Paragraph";
import SegmentedControl from "~/components/primitives/SegmentedControl";

const options = [
  { label: "Label 1", value: "developer" },
  { label: "Label 2", value: "Users" },
];

export default function Story() {
  return (
    <MainCenteredContainer className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Paragraph>Primary</Paragraph>
        <SegmentedControl name="name" options={options} variant="primary" />
      </div>
      <div className="flex flex-col gap-2">
        <Paragraph>Secondary</Paragraph>
        <SegmentedControl name="name" options={options} variant="secondary" />
      </div>
    </MainCenteredContainer>
  );
}
