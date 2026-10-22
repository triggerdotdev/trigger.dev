import { useState } from "react";
import { Switch } from "~/components/primitives/Switch";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Input } from "~/components/primitives/Input";
import { Button } from "~/components/primitives/Buttons";
import { cn } from "~/utils/cn";
import type { WorkerQueueEnvironmentOverride } from "~/v3/featureFlags";
import {
  availableOverrideScopes,
  orderedOverrideScopes,
  overrideScopeLabel,
  removeOverride,
  setOverrideField,
  type OverrideEnvironment,
  type WorkerQueueEnvironmentOverrides,
} from "./workerQueueEnvironmentOverrides";

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

export function NumberControl({
  value,
  onChange,
  min,
  max,
  dimmed,
}: {
  value: number | undefined;
  onChange: (val: number | undefined) => void;
  min?: number;
  max?: number;
  dimmed: boolean;
}) {
  // Number and string fields share the same input shape; surface the range
  // (or "number") as the placeholder so an unset field still signals its type.
  const placeholder = min !== undefined && max !== undefined ? `${min}-${max}` : "number";
  return (
    <Input
      type="number"
      variant="small"
      // Empty string when unset so the placeholder shows instead of "0".
      value={value ?? ""}
      min={min}
      max={max}
      step={1}
      onChange={(e) => {
        const next = e.target.valueAsNumber;
        onChange(Number.isNaN(next) ? undefined : next);
      }}
      placeholder={placeholder}
      className={cn("w-40", dimmed && "opacity-50")}
    />
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

type Compat = WorkerQueueEnvironmentOverride["compat"];
type Channel = WorkerQueueEnvironmentOverride["channel"];

function fromEnumValue<T extends string>(val: string): T | undefined {
  return val === UNSET_VALUE ? undefined : (val as T);
}

export function WorkerQueueEnvironmentOverridesControl({
  value,
  environments,
  compatOptions,
  channelOptions,
  onChange,
}: {
  value: WorkerQueueEnvironmentOverrides;
  environments: OverrideEnvironment[];
  compatOptions: string[];
  channelOptions: string[];
  onChange: (val: WorkerQueueEnvironmentOverrides | undefined) => void;
}) {
  const [draftScope, setDraftScope] = useState(UNSET_VALUE);
  const [draftCompat, setDraftCompat] = useState<Compat>(undefined);
  const [draftChannel, setDraftChannel] = useState<Channel>(undefined);

  const label = (scope: string) => overrideScopeLabel(scope, environments);
  const availableScopes = availableOverrideScopes(value, environments);
  const scopeItems = [UNSET_VALUE, ...availableScopes];
  const canAdd =
    availableScopes.includes(draftScope) &&
    (draftCompat !== undefined || draftChannel !== undefined);

  const addOverride = () => {
    if (!canAdd) return;
    const entry: WorkerQueueEnvironmentOverride = {};
    if (draftCompat !== undefined) entry.compat = draftCompat;
    if (draftChannel !== undefined) entry.channel = draftChannel;
    onChange({ ...value, [draftScope]: entry });
    setDraftScope(UNSET_VALUE);
    setDraftCompat(undefined);
    setDraftChannel(undefined);
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-2 gap-y-1.5">
      <div className="text-xs text-text-dimmed">scope</div>
      <div className="text-xs text-text-dimmed">compat</div>
      <div className="text-xs text-text-dimmed">channel</div>
      <div />

      {orderedOverrideScopes(value, environments).map((scope) => {
        const entry = value[scope];
        const incomplete = entry.compat === undefined && entry.channel === undefined;
        return (
          <div key={scope} className="contents">
            <div
              className={cn("truncate text-sm", incomplete ? "text-error" : "text-text-bright")}
              title={incomplete ? "Set compat or channel, or remove this row" : scope}
            >
              {label(scope)}
            </div>
            <EnumControl
              value={entry.compat}
              options={compatOptions}
              onChange={(val) =>
                onChange(
                  setOverrideField(value, scope, "compat", fromEnumValue<NonNullable<Compat>>(val))
                )
              }
              dimmed={false}
            />
            <EnumControl
              value={entry.channel}
              options={channelOptions}
              onChange={(val) =>
                onChange(
                  setOverrideField(
                    value,
                    scope,
                    "channel",
                    fromEnumValue<NonNullable<Channel>>(val)
                  )
                )
              }
              dimmed={false}
            />
            <Button variant="minimal/small" onClick={() => onChange(removeOverride(value, scope))}>
              remove
            </Button>
          </div>
        );
      })}

      <Select
        variant="tertiary/small"
        value={draftScope}
        setValue={setDraftScope}
        items={scopeItems}
        filter={(item, search) => label(item).toLowerCase().includes(search.toLowerCase())}
        text={(val) => (val === UNSET_VALUE ? "add environment..." : label(val))}
      >
        {(items) =>
          items.map((item) => (
            <SelectItem key={item} value={item}>
              {item === UNSET_VALUE ? "none" : label(item)}
            </SelectItem>
          ))
        }
      </Select>
      <EnumControl
        value={draftCompat}
        options={compatOptions}
        onChange={(val) => setDraftCompat(fromEnumValue<NonNullable<Compat>>(val))}
        dimmed={draftScope === UNSET_VALUE}
      />
      <EnumControl
        value={draftChannel}
        options={channelOptions}
        onChange={(val) => setDraftChannel(fromEnumValue<NonNullable<Channel>>(val))}
        dimmed={draftScope === UNSET_VALUE}
      />
      <Button variant="secondary/small" onClick={addOverride} disabled={!canAdd}>
        add
      </Button>
    </div>
  );
}
