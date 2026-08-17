import {
  ArrowUturnLeftIcon,
  PencilSquareIcon,
  PlusIcon,
  VariableIcon,
  ViewColumnsIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
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
  encodeColumnLayout,
  resolveColumnLayout,
  type LayoutColumn,
  type ResolvedColumn,
  type RunColumnRuntime,
  type SmartColumnDef,
} from "./runColumns";
import { AddSmartColumnDialog } from "./AddSmartColumnDialog";

function keyFor(col: ResolvedColumn): string {
  return col.kind === "standard" ? `std:${col.def.id}` : `smart:${col.index}`;
}

type SmartEditTarget = { index: number; def: SmartColumnDef };

export function RunsDisplayOptions() {
  const environment = useEnvironment();
  const { isManagedCloud } = useFeatures();
  const location = useOptimisticLocation();
  const { values, replace } = useSearchParams();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<SmartEditTarget | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

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

  const totalCount = layout.ordered.filter((o) => o.col.kind === "standard").length;
  const shownCount = layout.ordered.filter((o) => o.col.kind === "standard" && !o.hidden).length;

  const applyLayout = (next: LayoutColumn[]) => {
    const encoded = encodeColumnLayout(next, runtime);
    replace({
      cols: encoded.cols.length > 0 ? encoded.cols : undefined,
      sc: encoded.sc.length > 0 ? encoded.sc : undefined,
    });
  };

  const toggleHidden = (key: string) => {
    applyLayout(
      layout.ordered.map((o) => (keyFor(o.col) === key ? { ...o, hidden: !o.hidden } : o))
    );
  };

  const removeSmart = (index: number) => {
    applyLayout(layout.ordered.filter((o) => !(o.col.kind === "smart" && o.col.index === index)));
  };

  const submitSmart = (def: SmartColumnDef) => {
    if (editing) {
      applyLayout(
        layout.ordered.map((o) =>
          o.col.kind === "smart" && o.col.index === editing.index
            ? { ...o, col: { ...o.col, def } }
            : o
        )
      );
    } else {
      applyLayout([
        ...layout.ordered,
        { col: { kind: "smart", index: layout.smartColumns.length, def }, hidden: false },
      ]);
    }
  };

  const reset = () => replace({ cols: undefined, sc: undefined });

  const reorder = (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    const arr = [...layout.ordered];
    const from = arr.findIndex((o) => keyFor(o.col) === fromKey);
    const to = arr.findIndex((o) => keyFor(o.col) === toKey);
    if (from < 0 || to < 0) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    applyLayout(arr);
  };

  const endDrag = () => {
    setDragKey(null);
    setOverKey(null);
  };

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="secondary/small" LeadingIcon={ViewColumnsIcon} className="ml-auto">
            Display
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-0">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-medium text-text-dimmed">Columns</span>
            <span className="text-xs text-text-dimmed">
              {shownCount} of {totalCount}
            </span>
          </div>
          <div className="max-h-80 overflow-y-auto border-y border-grid-dimmed">
            {layout.ordered.map(({ col, hidden }) => {
              const key = keyFor(col);
              return (
                <ColumnRow
                  key={key}
                  col={col}
                  checked={!hidden}
                  locked={col.kind === "standard" && !!col.def.locked}
                  dragging={dragKey === key}
                  isOver={overKey === key && dragKey !== key}
                  onDragStart={() => setDragKey(key)}
                  onDragEnter={() => setOverKey(key)}
                  onDragEnd={endDrag}
                  onDrop={() => {
                    if (dragKey) reorder(dragKey, key);
                    endDrag();
                  }}
                  onToggle={() => toggleHidden(key)}
                  onEdit={
                    col.kind === "smart"
                      ? () => setEditing({ index: col.index, def: col.def })
                      : undefined
                  }
                  onRemove={col.kind === "smart" ? () => removeSmart(col.index) : undefined}
                />
              );
            })}
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
        open={addOpen || editing !== null}
        editing={editing?.def ?? null}
        onOpenChange={(next) => {
          if (!next) {
            setAddOpen(false);
            setEditing(null);
          }
        }}
        onSubmit={submitSmart}
        currentSearch={location.search}
      />
    </>
  );
}

function ColumnRow({
  col,
  checked,
  locked,
  dragging,
  isOver,
  onToggle,
  onEdit,
  onRemove,
  onDragStart,
  onDragEnter,
  onDragEnd,
  onDrop,
}: {
  col: ResolvedColumn;
  checked: boolean;
  locked: boolean;
  dragging: boolean;
  isOver: boolean;
  onToggle: () => void;
  onEdit?: () => void;
  onRemove?: () => void;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}) {
  const isSmart = col.kind === "smart";

  return (
    <div
      className={cn(
        "relative flex h-8 items-center gap-2 px-3 transition-colors hover:bg-charcoal-750",
        dragging && "opacity-40"
      )}
      draggable
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {isOver && <div className="absolute inset-x-0 top-0 h-0.5 bg-blue-500" />}
      {locked ? <Checkbox checked disabled /> : <Checkbox checked={checked} onChange={onToggle} />}
      {isSmart && <VariableIcon className="size-4 flex-none text-text-dimmed" />}
      <span
        className={cn("flex-1 truncate text-sm", checked ? "text-text-bright" : "text-text-dimmed")}
      >
        {col.def.label}
      </span>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${col.def.label}`}
          className="flex size-5 items-center justify-center rounded text-text-dimmed transition-colors hover:text-text-bright focus-custom"
        >
          <PencilSquareIcon className="size-3.5" />
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${col.def.label}`}
          className="flex size-5 items-center justify-center rounded text-text-dimmed transition-colors hover:text-error focus-custom"
        >
          <XMarkIcon className="size-3.5" />
        </button>
      )}
      <GripVerticalIcon className="size-4 cursor-grab text-text-dimmed active:cursor-grabbing" />
    </div>
  );
}
