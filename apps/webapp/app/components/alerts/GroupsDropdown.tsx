import { Select, SelectItem } from "~/components/primitives/Select";
import { MAX_VISIBLE_GROUPS } from "./queryGroupSelection";

type GroupsProps = {
  groups: string[];
  selected: string[];
  onToggle: (group: string) => void;
  max?: number;
  colors?: Map<string, string>;
};

export function GroupsDropdown({
  groups,
  selected,
  onToggle,
  max = MAX_VISIBLE_GROUPS,
  colors,
}: GroupsProps) {
  const full = selected.length >= max;

  return (
    <Select
      variant="tertiary/small"
      value={selected}
      setValue={(next) => {
        const changed =
          next.find((g) => !selected.includes(g)) ?? selected.find((g) => !next.includes(g));
        if (changed !== undefined) onToggle(changed);
      }}
      items={groups}
      filter={true}
      heading={groups.length > max ? `Search groups · Up to ${max} visible` : "Search groups"}
      text={`Groups ${selected.length}/${groups.length}`}
      clearSearchOnSelection={false}
      allowItemShortcuts={false}
      placement="bottom-end"
      empty="No groups match"
    >
      {(items) =>
        items.map((group) => (
          <SelectItem
            key={group}
            value={group}
            checkPosition="left"
            disabled={full && !selected.includes(group)}
          >
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                data-swatch={colors?.get(group)}
                className="size-2 shrink-0 rounded-full"
                style={{
                  backgroundColor: selected.includes(group) ? colors?.get(group) : "transparent",
                }}
              />
              {group}
            </span>
          </SelectItem>
        ))
      }
    </Select>
  );
}
