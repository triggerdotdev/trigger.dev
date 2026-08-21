import { PencilSquareIcon, StarIcon as StarIconSolid, XMarkIcon } from "@heroicons/react/20/solid";
import { StarIcon as StarIconOutline } from "@heroicons/react/24/outline";
import { GripVerticalIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ColumnsIcon } from "~/assets/icons/ColumnsIcon";
import { ResetIcon } from "~/assets/icons/ResetIcon";
import { SmartColumnIcon } from "~/assets/icons/SmartColumnIcon";
import { useFavoritePageToggle } from "~/components/navigation/favoritePages";
import { Button } from "~/components/primitives/Buttons";
import { Checkbox } from "~/components/primitives/Checkbox";
import {
  Popover,
  PopoverContent,
  PopoverMenuItem,
  PopoverTrigger,
} from "~/components/primitives/Popover";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useFeatures } from "~/hooks/useFeatures";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
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

/** The three footer actions share one icon size so the mixed icon sets line up. */
const FOOTER_ICON_CLASS = "size-[1.15rem]";

/** Opens the Columns popover. "l" is free on every list this control appears on. */
export const COLUMNS_SHORTCUT = { key: "l" as const };

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
  const [open, setOpen] = useState(false);
  // Whether this open came from the shortcut, which decides if focus moves into the list.
  const openedByShortcut = useRef(false);

  useShortcutKeys({
    shortcut: COLUMNS_SHORTCUT,
    action: (event) => {
      event.preventDefault();
      event.stopPropagation();
      openedByShortcut.current = true;
      setOpen((previous) => !previous);
    },
  });

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
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) openedByShortcut.current = false;
        }}
      >
        <SimpleTooltip
          asChild
          side="bottom"
          disableHoverableContent
          button={
            // Plain wrapper: Button drops the pointer-event props Radix injects via asChild,
            // so the tooltip anchor can't be the Button itself (same as NotificationPanel).
            <div className="flex">
              <PopoverTrigger asChild>
                <Button variant="secondary/small" LeadingIcon={ColumnsIcon}>
                  Columns
                </Button>
              </PopoverTrigger>
            </div>
          }
          content={
            <span className="flex items-center gap-2">
              Customize columns
              <ShortcutKey shortcut={COLUMNS_SHORTCUT} variant="small" />
            </span>
          }
        />
        <PopoverContent
          align="end"
          className="w-64 p-0"
          // Opened by shortcut: let Radix focus the first row so the list can be tabbed
          // straight away. Opened by mouse: keep focus put, or the first row's
          // hover-revealed reorder handle would appear before the cursor ever got there.
          onOpenAutoFocus={(event) => {
            if (!openedByShortcut.current) event.preventDefault();
            openedByShortcut.current = false;
          }}
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
              icon={SmartColumnIcon}
              title="Add smart column…"
              onClick={() => setAddOpen(true)}
              className="h-8"
              leadingIconClassName={FOOTER_ICON_CLASS}
            />
            {canFavorite && (
              <PopoverMenuItem
                icon={
                  isFavorited ? (
                    <StarIconSolid className={cn(FOOTER_ICON_CLASS, "text-yellow-500")} />
                  ) : (
                    // The outline star is 1.5px by default, noticeably thinner than the
                    // custom 2px icons beside it.
                    <StarIconOutline className={FOOTER_ICON_CLASS} strokeWidth={2} />
                  )
                }
                title={isFavorited ? "Remove from favorites" : "Save to favorites"}
                onClick={toggleFavorite}
                className="h-8"
              />
            )}
            {/* Wrapper carries the cursor: the disabled button has pointer-events-none. */}
            <div className={cn("flex", !layout.isCustomized && "cursor-not-allowed")}>
              <PopoverMenuItem
                icon={ResetIcon}
                title="Reset to default"
                onClick={reset}
                disabled={!layout.isCustomized}
                className="h-8 group-disabled/button:opacity-50 group-disabled/button:[&_span]:text-text-dimmed"
              />
            </div>
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

/** The label owns the focus ring (see ColumnRow), so the checkbox itself never rings. */
const CHECKBOX_NO_RING = "focus:ring-0 group-focus:ring-0 focus-visible:ring-0";

/**
 * The row's hover-revealed actions. Square, and hidden until the row is hovered or the
 * control itself takes keyboard focus (a checkbox click must not reveal them).
 */
const ROW_ACTION_CLASS =
  "aspect-square h-6 p-1 opacity-0 transition group-hover:opacity-100 group-focus-visible/button:opacity-100";

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
        "group relative flex h-8 items-center rounded-sm transition-colors hover:bg-background-hover",
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
      {isOver && <div className="absolute inset-x-0 top-0 h-0.5 bg-indigo-500" />}
      {/* Native label so the whole name area toggles the column, matching CheckboxWithLabel. */}
      {/* The label is the hit area, so it carries the focus ring rather than the checkbox
          inside it, and only for keyboard focus -- a click must not ring anything. */}
      <label
        className={cn(
          "flex h-full min-w-0 flex-1 items-center gap-x-2 rounded-sm pl-2",
          "has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:-outline-offset-1 has-[:focus-visible]:outline-text-link",
          locked ? "cursor-default" : "cursor-pointer"
        )}
      >
        {locked ? (
          <Checkbox checked disabled className={CHECKBOX_NO_RING} />
        ) : (
          <Checkbox checked={checked} onChange={onToggle} className={CHECKBOX_NO_RING} />
        )}
        <span className="flex min-w-0 items-center gap-x-1">
          <span
            className={cn("truncate text-2sm", checked ? "text-text-bright" : "text-text-dimmed")}
          >
            {col.def.label}
          </span>
          {isSmart && <SmartColumnIcon className="size-3.5 flex-none text-text-dimmed" />}
        </span>
      </label>
      <div className="flex flex-none items-center gap-0.5 pr-1">
        {onRemove && (
          <Button
            variant="minimal/small"
            onClick={onRemove}
            aria-label={`Remove ${col.def.label}`}
            LeadingIcon={<XMarkIcon className="size-4" />}
            className={cn(ROW_ACTION_CLASS, "group-hover/button:text-error")}
          />
        )}
        {onEdit && (
          <Button
            variant="minimal/small"
            onClick={onEdit}
            aria-label={`Edit ${col.def.label}`}
            LeadingIcon={<PencilSquareIcon className="size-4" />}
            className={ROW_ACTION_CLASS}
          />
        )}
        {/* Button forwards no onKeyDown, so the arrow-key reorder listens on the wrapper
            and catches the event bubbling up from the focused button. */}
        <span
          role="presentation"
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              onMove(-1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              onMove(1);
            }
          }}
        >
          <Button
            variant="minimal/small"
            aria-label={`Reorder ${col.def.label} (use arrow up and down)`}
            LeadingIcon={<GripVerticalIcon className="size-4" />}
            className={cn(
              ROW_ACTION_CLASS,
              "cursor-grab group-hover/button:bg-transparent active:cursor-grabbing"
            )}
          />
        </span>
      </div>
    </div>
  );
}
