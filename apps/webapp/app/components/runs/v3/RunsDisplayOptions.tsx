import {
  ArrowUturnLeftIcon,
  PencilSquareIcon,
  PlusIcon,
  BoltIcon,
  StarIcon as StarIconSolid,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import { StarIcon as StarIconOutline } from "@heroicons/react/24/outline";
import { GripVerticalIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { ColumnsIcon } from "~/assets/icons/ColumnsIcon";
import { useFavoritePageToggle } from "~/components/navigation/favoritePages";
import { Button } from "~/components/primitives/Buttons";
import { Checkbox } from "~/components/primitives/Checkbox";
import {
  Popover,
  PopoverContent,
  PopoverMenuItem,
  PopoverTrigger,
} from "~/components/primitives/Popover";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useFeatures } from "~/hooks/useFeatures";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useSearchParams } from "~/hooks/useSearchParam";
import { cn } from "~/utils/cn";
import {
  encodeColumnLayout,
  parseColumnParams,
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

export function RunsDisplayOptions({
  sampleFilters,
}: {
  sampleFilters?: Record<string, string>;
} = {}) {
  const environment = useEnvironment();
  const { isManagedCloud } = useFeatures();
  const location = useOptimisticLocation();
  const { value, values, replace } = useSearchParams();
  // Same favorite the page-header star toggles, so the two stay in lockstep on this URL.
  const { isFavorited, canFavorite, toggle: toggleFavorite } = useFavoritePageToggle();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<SmartEditTarget | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const runtime: RunColumnRuntime = {
    isManagedCloud,
    isDevelopment: environment.type === "DEVELOPMENT",
  };

  const colsParam = value("cols");
  const hideParam = value("hide");
  const sc = values("sc");
  const layout = useMemo(
    () => resolveColumnLayout(parseColumnParams(colsParam, sc, hideParam), runtime),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [colsParam, hideParam, sc.join(" "), runtime.isManagedCloud, runtime.isDevelopment]
  );

  const totalCount = layout.ordered.filter((o) => o.col.kind === "standard").length;
  const shownCount = layout.ordered.filter((o) => o.col.kind === "standard" && !o.hidden).length;

  const applyLayout = (next: LayoutColumn[]) => {
    const encoded = encodeColumnLayout(next, runtime);
    replace({
      cols: encoded.cols.length > 0 ? encoded.cols.join(",") : undefined,
      sc: encoded.sc.length > 0 ? encoded.sc : undefined,
      hide: encoded.hide.length > 0 ? encoded.hide.join(",") : undefined,
    });
  };

  const reset = () => replace({ cols: undefined, sc: undefined, hide: undefined });

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

  const reorder = (fromKey: string, toKey: string) => {
    if (fromKey === toKey) return;
    const arr = [...layout.ordered];
    const from = arr.findIndex((o) => keyFor(o.col) === fromKey);
    const to = arr.findIndex((o) => keyFor(o.col) === toKey);
    if (from < 0 || to < 0) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(from < to ? to - 1 : to, 0, moved);
    applyLayout(arr);
  };

  const move = (key: string, delta: number) => {
    const arr = [...layout.ordered];
    const from = arr.findIndex((o) => keyFor(o.col) === key);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= arr.length) return;
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
          <Button variant="secondary/small" LeadingIcon={ColumnsIcon}>
            Columns
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-64 p-0"
          // Radix otherwise focuses the first item on open, and the row's hover-revealed
          // reorder handle would show through :focus-within before the mouse ever gets there.
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-medium text-text-dimmed">Columns</span>
            <span className="text-xs text-text-dimmed">
              {shownCount} of {totalCount}
            </span>
          </div>
          <div className="max-h-80 overflow-y-auto border-y border-grid-dimmed p-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
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
                  onMove={(delta) => move(key, delta)}
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
            <PopoverMenuItem
              icon={PlusIcon}
              title="Add smart column…"
              onClick={() => setAddOpen(true)}
            />
            {canFavorite && (
              <PopoverMenuItem
                icon={
                  isFavorited ? (
                    <StarIconSolid className="size-4 text-yellow-500" />
                  ) : (
                    <StarIconOutline className="size-4" />
                  )
                }
                title={isFavorited ? "Remove from favorites" : "Save to favorites"}
                onClick={toggleFavorite}
              />
            )}
            <PopoverMenuItem
              icon={ArrowUturnLeftIcon}
              title="Reset to default"
              onClick={reset}
              disabled={!layout.isCustomized}
            />
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
        sampleFilters={sampleFilters}
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
  onMove,
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
  onMove: (delta: number) => void;
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
        "group relative flex h-[1.8rem] items-center rounded-sm transition-colors hover:bg-background-hover",
        dragging && "opacity-40"
      )}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", "");
        onDragStart();
      }}
      onDragEnter={onDragEnter}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      {isOver && <div className="absolute inset-x-0 top-0 h-0.5 bg-blue-500" />}
      {/* Native label so the whole name area toggles the column, matching CheckboxWithLabel. */}
      <label
        className={cn(
          "flex h-full min-w-0 flex-1 items-center gap-x-1.5 pl-[0.4rem]",
          locked ? "cursor-default" : "cursor-pointer"
        )}
      >
        {locked ? (
          <Checkbox checked disabled />
        ) : (
          <Checkbox checked={checked} onChange={onToggle} />
        )}
        <span
          className={cn("truncate text-2sm", checked ? "text-text-bright" : "text-text-dimmed")}
        >
          {col.def.label}
        </span>
        {isSmart && <BoltIcon className="size-3.5 flex-none text-text-dimmed" />}
      </label>
      <div className="flex flex-none items-center gap-0.5 pr-[0.4rem]">
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${col.def.label}`}
            className="flex size-6 cursor-pointer items-center justify-center rounded-sm text-text-dimmed opacity-0 transition hover:bg-charcoal-700 hover:text-text-bright focus-custom group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <PencilSquareIcon className="size-4" />
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${col.def.label}`}
            className="flex size-6 cursor-pointer items-center justify-center rounded-sm text-text-dimmed opacity-0 transition hover:bg-charcoal-700 hover:text-error focus-custom group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <XMarkIcon className="size-4" />
          </button>
        )}
        <button
          type="button"
          aria-label={`Reorder ${col.def.label} (use arrow up and down)`}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              onMove(-1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              onMove(1);
            }
          }}
          className="flex size-6 cursor-grab items-center justify-center rounded-sm text-text-dimmed opacity-0 transition hover:bg-charcoal-700 hover:text-text-bright focus-custom group-hover:opacity-100 group-focus-within:opacity-100 active:cursor-grabbing"
        >
          <GripVerticalIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}
