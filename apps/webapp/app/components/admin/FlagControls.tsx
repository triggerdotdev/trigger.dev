import { Switch } from "~/components/primitives/Switch";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Input } from "~/components/primitives/Input";
import { cn } from "~/utils/cn";

export const UNSET_VALUE = "__unset__";

export function BooleanControl({
  value,
  onChange,
  dimmed,
}: {
  value: boolean | undefined;
  onChange: (val: boolean) => void;
  dimmed: boolean;
}) {
  return (
    <Switch
      variant="small"
      checked={value ?? false}
      onCheckedChange={onChange}
      className={cn(dimmed && "opacity-50")}
    />
  );
}

export function EnumControl({
  value,
  options,
  onChange,
  dimmed,
}: {
  value: string | undefined;
  options: string[];
  onChange: (val: string) => void;
  dimmed: boolean;
}) {
  const items = [UNSET_VALUE, ...options];

  return (
    <Select
      variant="tertiary/small"
      value={value ?? UNSET_VALUE}
      setValue={onChange}
      items={items}
      text={(val) => (val === UNSET_VALUE ? "unset" : val)}
      className={cn(dimmed && "opacity-50")}
    >
      {(items) =>
        items.map((item) => (
          <SelectItem key={item} value={item}>
            {item === UNSET_VALUE ? "unset" : item}
          </SelectItem>
        ))
      }
    </Select>
  );
}

export type WorkerGroup = { id: string; name: string };

export function WorkerGroupControl({
  value,
  workerGroups,
  onChange,
  dimmed,
}: {
  value: string | undefined;
  workerGroups: WorkerGroup[];
  onChange: (val: string) => void;
  dimmed: boolean;
}) {
  const items = [UNSET_VALUE, ...workerGroups.map((wg) => wg.id)];

  return (
    <Select
      variant="tertiary/small"
      value={value ?? UNSET_VALUE}
      setValue={onChange}
      items={items}
      text={(val) => {
        if (val === UNSET_VALUE) return "unset";
        const wg = workerGroups.find((w) => w.id === val);
        return wg ? wg.name : val;
      }}
      className={cn(dimmed && "opacity-50")}
    >
      {(items) =>
        items.map((item) => {
          const wg = workerGroups.find((w) => w.id === item);
          return (
            <SelectItem key={item} value={item}>
              {item === UNSET_VALUE ? "unset" : wg ? wg.name : item}
            </SelectItem>
          );
        })
      }
    </Select>
  );
}

export function StringControl({
  value,
  onChange,
  dimmed,
}: {
  value: string;
  onChange: (val: string) => void;
  dimmed: boolean;
}) {
  return (
    <Input
      variant="small"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="unset"
      className={cn("w-40", dimmed && "opacity-50")}
    />
  );
}
