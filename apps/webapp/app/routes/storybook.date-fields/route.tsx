import { DateField } from "~/components/primitives/DateField";
import { Header2 } from "~/components/primitives/Headers";

export default function Story() {
  return (
    <div className="m-8 space-y-8">
      <div className="flex flex-col gap-4">
        <Header2>Size = small</Header2>
        <DateField label="From (UTC)" granularity="second" showNowButton showClearButton />
        <DateField
          label="From (UTC)"
          defaultValue={new Date()}
          granularity="second"
          showNowButton
          showClearButton
        />
      </div>
      <div className="flex flex-col gap-4">
        <Header2>Size = medium</Header2>
        <DateField
          label="From (UTC)"
          granularity="second"
          showNowButton
          showClearButton
          variant="medium"
        />
        <DateField
          label="From (UTC)"
          defaultValue={new Date()}
          granularity="second"
          showNowButton
          showClearButton
          variant="medium"
        />
      </div>
    </div>
  );
}
