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
} from "../primitives/Select";
import { EventListSearchSchema } from "./EventStatuses";
import { environmentKeys, FilterableEnvironment } from "~/components/runs/RunStatuses";

export function EventsFilters() {
  const navigate = useNavigate();
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const { environment } = EventListSearchSchema.parse(Object.fromEntries(searchParams.entries()));

  const handleFilterChange = (filterType: string, value: string | undefined) => {
    if (value) {
      searchParams.set(filterType, value);
    } else {
      searchParams.delete(filterType);
    }
    searchParams.delete("cursor");
    searchParams.delete("direction");
    navigate(`${location.pathname}?${searchParams.toString()}`);
  };

  const handleEnvironmentChange = (value: FilterableEnvironment | "ALL") => {
    handleFilterChange("environment", value === "ALL" ? undefined : value);
  };

  return (
    <div className="flex flex-row justify-between gap-x-2">
      <SelectGroup>
        <Select
          name="environment"
          value={environment ?? "ALL"}
          onValueChange={handleEnvironmentChange}
        >
          <SelectTrigger size="secondary/small" width="full">
            <SelectValue placeholder={"Select environment"} className="ml-2 p-0" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={"ALL"}>
              <Paragraph variant="extra-small" className="pl-0.5">
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
    </div>
  );
}
