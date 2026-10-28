import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
import { Button } from "~/components/primitives/Buttons";
import { Select, SelectItem } from "~/components/primitives/Select";
import { adjacentUsageMonths, formatUsageMonth } from "~/utils/billingUsagePeriod";

export function MonthStepper({
  months,
  month,
  onChange,
}: {
  months: string[];
  month: string;
  onChange: (month: string) => void;
}) {
  const { previous, next } = adjacentUsageMonths(month, months);

  return (
    <div className="flex items-center gap-2">
      <Select
        name="month"
        value={month}
        setValue={(value) => onChange(value)}
        items={months.map((value) => ({ value, label: formatUsageMonth(value) }))}
        text={(value) => formatUsageMonth(value)}
        dropdownIcon
        variant="tertiary/small"
      >
        {(items) =>
          items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))
        }
      </Select>
      <div className="flex">
        <Button
          variant="secondary/small"
          LeadingIcon={ChevronLeftIcon}
          className="rounded-r-none border-r-0 pl-2 pr-2.25"
          tooltip="Previous month"
          aria-label="Previous month"
          disabled={!previous}
          onClick={() => previous && onChange(previous)}
        />
        <Button
          variant="secondary/small"
          LeadingIcon={ChevronRightIcon}
          className="rounded-l-none pl-2.25 pr-2"
          tooltip="Next month"
          aria-label="Next month"
          disabled={!next}
          onClick={() => next && onChange(next)}
        />
      </div>
    </div>
  );
}
