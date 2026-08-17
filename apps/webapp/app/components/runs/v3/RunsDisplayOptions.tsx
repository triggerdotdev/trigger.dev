import { ArrowUturnLeftIcon, PlusIcon, ViewColumnsIcon } from "@heroicons/react/20/solid";
import { GripVerticalIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { Checkbox } from "~/components/primitives/Checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useFeatures } from "~/hooks/useFeatures";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useSearchParams } from "~/hooks/useSearchParam";
import { cn } from "~/utils/cn";
import {
  availableStandardColumns,
  encodeColumnLayout,
  resolveColumnLayout,
  type ResolvedColumn,
  type RunColumnRuntime,
  type SmartColumnDef,
} from "./runColumns";
import { AddSmartColumnDialog } from "./AddSmartColumnDialog";
import { SMART_SOURCE_DOT_COLOR } from "./smartColumnData";

function keyFor(col: ResolvedColumn): string {
  return col.kind === "standard" ? `std:${col.def.id}` : `smart:${col.index}`;
}

export function RunsDisplayOptions() {
  const environment = useEnvironment();
  const { isManagedCloud } = useFeatures();
  const location = useOptimisticLocation();
  const { values, replace } = useSearchParams();
  const [addOpen, setAddOpen] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);

  const runtime: RunColumnRuntime = {
    isManagedCloud,
    isDevelopment: environment.type === "DEVELOPMENT",
  };

  const cols = values("cols");
  const sc = values("sc");
  const layout = useMemo(
    () => resolveColumnLayout({ cols, sc }, runtime),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cols.join(" "), sc.join(" "), runtime.isManagedCloud, runtime.isDevelopment]
  );

  const available = availableStandardColumns(runtime);
  const visibleStandardCount = layout.visible.filter((c) => c.kind === "standard").length;
  const smartCount = layout.visible.filter((c) => c.kind === "smart").length;

  const applyVisible = (nextVisible: ResolvedColumn[]) => {
    const encoded = encodeColumnLayout(nextVisible, runtime);
    replace({
      cols: encoded.cols.length > 0 ? encoded.cols : undefined,
      sc: encoded.sc.length > 0 ? encoded.sc : undefined,
    });
  };

  const hideStandard = (id: string) => {
    applyVisible(layout.visible.filter((c) => !(c.kind === "standard" && c.def.id === id)));
  };

  const showStandard = (id: string) => {
    const def = available.find((c) => c.id === id);
    if (!def) return;
    applyVisible([...layout.visible, { kind: "standard", def }]);
  };

  const removeSmart = (index: number) => {
    applyVisible(layout.visible.filter((c) => !(c.kind === "smart" && c.index === index)));
  };

  const addSmart = (def: SmartColumnDef) => {
    const nextIndex = layout.smartColumns.length;
    applyVisible([...layout.visible, { kind: "smart", index: nextIndex, def }]);
  };

  const reset = () => replace({ cols: undefined, sc: undefined });

  const reorder = (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    const arr = [...layout.visible];
    const from = arr.findIndex((c) => keyFor(c) === fromKey);
    const to = arr.findIndex((c) => keyFor(c) === toKey);
    if (from < 0 || to < 0) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    applyVisible(arr);
  };

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="secondary/small" LeadingIcon={ViewColumnsIcon} className="ml-auto">
            <span className="flex items-center gap-1.5">
              Display
              {smartCount > 0 && (
                <span className="text-xs text-text-dimmed">{smartCount} smart</span>
              )}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-0">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-medium text-text-dimmed">Columns</span>
            <span className="text-xs text-text-dimmed">
              {visibleStandardCount} of {available.length}
            </span>
          </div>
          <div className="max-h-80 overflow-y-auto border-y border-grid-dimmed">
            {layout.visible.map((col) => (
              <ColumnRow
                key={keyFor(col)}
                col={col}
                checked
                draggable
                locked={col.kind === "standard" && !!col.def.locked}
                dragging={dragKey === keyFor(col)}
                onDragStart={() => setDragKey(keyFor(col))}
                onDragEnd={() => setDragKey(null)}
                onDrop={() => {
                  if (dragKey) reorder(dragKey, keyFor(col));
                  setDragKey(null);
                }}
                onToggle={() => {
                  if (col.kind === "smart") removeSmart(col.index);
                  else if (!col.def.locked) hideStandard(col.def.id);
                }}
              />
            ))}
            {layout.hiddenStandard.map((def) => (
              <ColumnRow
                key={`std:${def.id}`}
                col={{ kind: "standard", def }}
                checked={false}
                draggable={false}
                locked={false}
                dragging={false}
                onToggle={() => showStandard(def.id)}
              />
            ))}
          </div>
          <div className="flex flex-col p-1">
            <button
              type="button"
              className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-text-bright transition-colors hover:bg-charcoal-750 focus-custom"
              onClick={() => setAddOpen(true)}
            >
              <PlusIcon className="size-4 text-text-dimmed" />
              Add smart column…
            </button>
            <button
              type="button"
              className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-text-dimmed transition-colors hover:bg-charcoal-750 hover:text-text-bright focus-custom disabled:opacity-50"
              onClick={reset}
              disabled={!layout.isCustomized}
            >
              <ArrowUturnLeftIcon className="size-4" />
              Reset to default
            </button>
          </div>
        </PopoverContent>
      </Popover>
      <AddSmartColumnDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdd={addSmart}
        currentSearch={location.search}
      />
    </>
  );
}

function ColumnRow({
  col,
  checked,
  draggable,
  locked,
  dragging,
  onToggle,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  col: ResolvedColumn;
  checked: boolean;
  draggable: boolean;
  locked: boolean;
  dragging: boolean;
  onToggle: () => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDrop?: () => void;
}) {
  const isSmart = col.kind === "smart";
  const label = col.def.label;
  const isDuration = col.kind === "standard" && col.def.id === "dur";

  return (
    <div
      className={cn(
        "flex h-8 items-center gap-2 px-3 transition-colors hover:bg-charcoal-750",
        dragging && "opacity-40"
      )}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        if (draggable) e.preventDefault();
      }}
      onDrop={onDrop}
    >
      {locked ? (
        <Checkbox checked disabled />
      ) : (
        <Checkbox checked={checked} onChange={onToggle} />
      )}
      {isSmart && (
        <span
          className={cn("size-2 flex-none rounded-full", SMART_SOURCE_DOT_COLOR[col.def.source])}
        />
      )}
      <span
        className={cn("flex-1 truncate text-sm", checked ? "text-text-bright" : "text-text-dimmed")}
      >
        {label}
      </span>
      {isDuration && <span className="text-xs text-text-dimmed">3 cells</span>}
      {draggable ? (
        <GripVerticalIcon className="size-4 cursor-grab text-text-dimmed active:cursor-grabbing" />
      ) : (
        <div className="size-4" />
      )}
    </div>
  );
}
