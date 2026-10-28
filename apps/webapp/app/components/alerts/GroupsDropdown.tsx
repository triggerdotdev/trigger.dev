import { Select, SelectItem } from "~/components/primitives/Select";
import { MAX_VISIBLE_GROUPS } from "./queryGroupSelection";

type GroupsProps = {
  groups: string[];
  selected: string[];
  onToggle: (group: string) => void;
  max?: number;
  colors?: Map<string, string>;
  noun?: string;
};

export function GroupsDropdown({
  groups,
  selected,
  onToggle,
  max = MAX_VISIBLE_GROUPS,
  colors,
  noun = "groups",
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
      heading={groups.length > max ? `Search ${noun} · Up to ${max} visible` : `Search ${noun}`}
      text={`${noun[0]!.toUpperCase()}${noun.slice(1)} ${selected.length}/${groups.length}`}
      clearSearchOnSelection={false}
      allowItemShortcuts={false}
      placement="bottom-end"
      empty={`No ${noun} match`}
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
