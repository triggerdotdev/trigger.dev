import { MainCenteredContainer } from "~/components/layout/AppLayout";
import SegmentedControl from "~/components/primitives/SegmentedControl";

const options = [
  { label: "Label 1", value: "developer" },
  { label: "Label 2", value: "Users" },
];

export default function Story() {
  return (
    <MainCenteredContainer>
      <SegmentedControl name="name" options={options} />
    </MainCenteredContainer>
  );
}
