import { useNavigate } from "@remix-run/react";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { EnvironmentLabel } from "../environments/EnvironmentLabel";
import { Paragraph } from "../primitives/Paragraph";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../primitives/SimpleSelect";
import { EventListSearchSchema } from "./EventStatuses";
import { environmentKeys, type FilterableEnvironment } from "~/components/runs/RunStatuses";
import { TimeFrameFilter } from "../runs/TimeFrameFilter";
import { useCallback } from "react";
import { Button } from "../primitives/Buttons";
import { TrashIcon } from "@heroicons/react/20/solid";

export function EventsFilters() {
  const navigate = useNavigate();
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const { environment, from, to } = EventListSearchSchema.parse(
    Object.fromEntries(searchParams.entries())
  );

  const handleFilterChange = useCallback((filterType: string, value: string | undefined) => {
    if (value) {
      searchParams.set(filterType, value);
    } else {
      searchParams.delete(filterType);
    }
    searchParams.delete("cursor");
    searchParams.delete("direction");
    navigate(`${location.pathname}?${searchParams.toString()}`);
  }, []);

  const handleTimeFrameChange = useCallback((range: { from?: number; to?: number }) => {
    if (range.from) {
      searchParams.set("from", range.from.toString());
    } else {
      searchParams.delete("from");
    }

    if (range.to) {
      searchParams.set("to", range.to.toString());
    } else {
      searchParams.delete("to");
    }

    searchParams.delete("cursor");
    searchParams.delete("direction");
    navigate(`${location.pathname}?${searchParams.toString()}`);
  }, []);

  const handleEnvironmentChange = (value: FilterableEnvironment | "ALL") => {
    handleFilterChange("environment", value === "ALL" ? undefined : value);
  };

  const clearFilters = useCallback(() => {
    searchParams.delete("status");
    searchParams.delete("environment");
    searchParams.delete("from");
    searchParams.delete("to");
    navigate(`${location.pathname}?${searchParams.toString()}`);
  }, []);

  return (
    <div className="flex flex-row justify-between">
      <SelectGroup>
        <Select
          name="environment"
          value={environment ?? "ALL"}
          onValueChange={handleEnvironmentChange}
        >
          <SelectTrigger size="minimal" width="full">
            <SelectValue placeholder={"Select environment"} className="ml-2 p-0" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={"ALL"}>
              <Paragraph
                variant="extra-small"
                className="pl-0.5 transition group-hover:text-text-bright"
              >
                All environments
              </Paragraph>
            </SelectItem>
            {environmentKeys.map((env) => (
              <SelectItem key={env} value={env}>
                <div className="flex items-center gap-x-2">
                  <EnvironmentLabel environment={{ type: env }} />
                  <Paragraph variant="extra-small">environment</Paragraph>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SelectGroup>

      <TimeFrameFilter from={from} to={to} onRangeChanged={handleTimeFrameChange} />

      <Button variant="minimal/small" onClick={() => clearFilters()} LeadingIcon={TrashIcon} />
    </div>
  );
}
