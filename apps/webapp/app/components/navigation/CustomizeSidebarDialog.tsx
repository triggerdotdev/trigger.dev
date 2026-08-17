import { DialogClose } from "@radix-ui/react-dialog";
import { ArrowDownIcon, ArrowUpIcon } from "@heroicons/react/20/solid";
import { GripVerticalIcon } from "lucide-react";
import { useState } from "react";
import ReactGridLayout, { type Layout, useContainerWidth } from "react-grid-layout";
import { CrossIcon } from "~/assets/icons/CrossIcon";
import { EyeClosedIcon } from "~/assets/icons/EyeClosedIcon";
import { EyeOpenIcon } from "~/assets/icons/EyeOpenIcon";
import { cn } from "~/utils/cn";
import { Button } from "../primitives/Buttons";
import { DialogContent, DialogFooter, DialogHeader } from "../primitives/Dialog";
import { FormError } from "../primitives/FormError";
import { Header3 } from "../primitives/Headers";
import { Icon, type RenderIcon } from "../primitives/Icon";
import { Input } from "../primitives/Input";
import { isItemHidden, orderByPreference } from "./sideMenuTypes";

type CustomizeSidebarItem = {
  id: string;
  name: string;
  icon: RenderIcon;
  iconClassName?: string;
  defaultHidden?: boolean;
  /** Favorites get an inline-editable name in the modal. */
  isFavorite?: boolean;
};

export type CustomizeSidebarSection = {
  id: string;
  title: string;
  /** Items in DEFAULT order (favorites: saved order — that is their default). */
  items: CustomizeSidebarItem[];
};

type SavedPreferences = {
  sectionOrder?: string[];
  hiddenItems?: Record<string, boolean>;
  sectionItemOrder?: Record<string, string[]>;
};

/** What Confirm produces; null clears a stored preference back to its default. */
export type SidebarCustomizationPayload = {
  sectionOrder: string[] | null;
  hiddenItems: Record<string, boolean> | null;
  sectionItemOrder: Record<string, string[]> | null;
  favorites?: Array<{ id: string; label: string }>;
  removedFavoriteIds?: string[];
};

type DialogState = {
  sectionOrder: string[];
  /** section id -> item ids in order */
  itemOrders: Record<string, string[]>;
  /** item id -> effective hidden */
  hidden: Record<string, boolean>;
  /** favorite id -> label being edited */
  labels: Record<string, string>;
  /** favorite ids staged for removal; applied on Confirm */
  removed: string[];
};

const FAVORITES_SECTION_ID = "favorites";
const ROW_HEIGHT = 44;

function buildState(
  sections: CustomizeSidebarSection[],
  prefs: SavedPreferences | undefined
): DialogState {
  const orderedSections = prefs ? orderByPreference(sections, prefs.sectionOrder) : sections;

  const itemOrders: Record<string, string[]> = {};
  const hidden: Record<string, boolean> = {};
  const labels: Record<string, string> = {};

  for (const section of sections) {
    // Favorites' array order is canonical (already applied), so saved item order only applies to
    // the static sections.
    const orderedItems =
      prefs && section.id !== FAVORITES_SECTION_ID
        ? orderByPreference(section.items, prefs.sectionItemOrder?.[section.id])
        : section.items;
    itemOrders[section.id] = orderedItems.map((item) => item.id);

    for (const item of section.items) {
      hidden[item.id] = prefs
        ? isItemHidden(item, prefs.hiddenItems)
        : (item.defaultHidden ?? false);
      if (item.isFavorite) {
        labels[item.id] = item.name;
      }
    }
  }

  return {
    sectionOrder: orderedSections.map((section) => section.id),
    itemOrders,
    hidden,
    labels,
    removed: [],
  };
}

function arraysEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The "Customize sidebar" modal: reorder sections (arrows), reorder items (drag), hide/show items
 * (eye), and rename favorites inline. Nothing is applied until Confirm; Reset restores the default
 * layout without touching which pages are favorited.
 */
export function CustomizeSidebarDialog({
  sections,
  prefs,
  onConfirm,
  isConfirming,
  confirmError,
}: {
  sections: CustomizeSidebarSection[];
  prefs: SavedPreferences | undefined;
  /**
   * Owned by the parent: closing this dialog unmounts it, so it can't run its own fetcher. The
   * parent submits the payload and closes the dialog once the save lands (or reports back via
   * `confirmError`), so a failed save never silently reads as a successful one.
   */
  onConfirm: (payload: SidebarCustomizationPayload) => void;
  /** True from Confirm until the save (and the refreshed side menu data) lands. */
  isConfirming: boolean;
  /** Save failure to surface next to Confirm; the dialog stays open for a retry. */
  confirmError?: string;
}) {
  const [state, setState] = useState<DialogState>(() => buildState(sections, prefs));

  // The Favorites section disappears with its last staged-removed favorite, matching the side
  // menu (which hides the section when empty)
  const displayedSections = (current: DialogState) =>
    current.sectionOrder
      .map((id) => sections.find((section) => section.id === id))
      .filter((section): section is CustomizeSidebarSection => section !== undefined)
      .filter(
        (section) =>
          section.id !== FAVORITES_SECTION_ID ||
          section.items.some((item) => !current.removed.includes(item.id))
      );

  const orderedSections = displayedSections(state);

  const moveSection = (sectionId: string, direction: -1 | 1) => {
    setState((current) => {
      // Swap with the DISPLAYED neighbor: a hidden Favorites entry may still sit in
      // sectionOrder between two visible sections
      const displayed = displayedSections(current).map((section) => section.id);
      const neighborId = displayed[displayed.indexOf(sectionId) + direction];
      if (!neighborId) return current;
      const next = [...current.sectionOrder];
      const a = next.indexOf(sectionId);
      const b = next.indexOf(neighborId);
      [next[a], next[b]] = [next[b], next[a]];
      return { ...current, sectionOrder: next };
    });
  };

  const reorderItems = (sectionId: string, itemIds: string[]) => {
    setState((current) => ({
      ...current,
      itemOrders: { ...current.itemOrders, [sectionId]: itemIds },
    }));
  };

  const toggleHidden = (itemId: string) => {
    setState((current) => ({
      ...current,
      hidden: { ...current.hidden, [itemId]: !current.hidden[itemId] },
    }));
  };

  const setLabel = (itemId: string, label: string) => {
    setState((current) => ({ ...current, labels: { ...current.labels, [itemId]: label } }));
  };

  const removeFavorite = (itemId: string) => {
    setState((current) => ({ ...current, removed: [...current.removed, itemId] }));
  };

  // Reset restores the default layout (positions + visibility) but never touches favorite names
  // or staged removals; Cancel is the way out of those
  const reset = () =>
    setState((current) => ({
      ...buildState(sections, undefined),
      labels: current.labels,
      removed: current.removed,
    }));

  const hasBlankLabels = sections.some((section) =>
    section.items.some(
      (item) =>
        item.isFavorite &&
        !state.removed.includes(item.id) &&
        (state.labels[item.id] ?? item.name).trim().length === 0
    )
  );

  const confirm = () => {
    const defaults = buildState(sections, undefined);

    const hiddenOverrides: Record<string, boolean> = {};
    for (const section of sections) {
      for (const item of section.items) {
        if (state.removed.includes(item.id)) continue;
        const isHidden = state.hidden[item.id] ?? false;
        if (isHidden !== (item.defaultHidden ?? false)) {
          hiddenOverrides[item.id] = isHidden;
        }
      }
    }

    const sectionItemOrder: Record<string, string[]> = {};
    for (const section of sections) {
      if (section.id === FAVORITES_SECTION_ID) continue;
      const order = state.itemOrders[section.id] ?? [];
      if (!arraysEqual(order, defaults.itemOrders[section.id] ?? [])) {
        sectionItemOrder[section.id] = order;
      }
    }

    const favoritesSection = sections.find((section) => section.id === FAVORITES_SECTION_ID);
    const favoriteOrder = (state.itemOrders[FAVORITES_SECTION_ID] ?? []).filter(
      (id) => !state.removed.includes(id)
    );
    const favoritesChanged =
      favoritesSection !== undefined &&
      (state.removed.length > 0 ||
        !arraysEqual(favoriteOrder, defaults.itemOrders[FAVORITES_SECTION_ID] ?? []) ||
        favoritesSection.items.some(
          (item) =>
            !state.removed.includes(item.id) &&
            (state.labels[item.id] ?? item.name).trim() !== item.name
        ));

    // Parts equal to the defaults are sent as null so the stored preference is cleared, not pinned
    const payload: SidebarCustomizationPayload = {
      sectionOrder: arraysEqual(state.sectionOrder, defaults.sectionOrder)
        ? null
        : state.sectionOrder,
      hiddenItems: Object.keys(hiddenOverrides).length > 0 ? hiddenOverrides : null,
      sectionItemOrder: Object.keys(sectionItemOrder).length > 0 ? sectionItemOrder : null,
      favorites: favoritesChanged
        ? favoriteOrder.map((id) => ({ id, label: state.labels[id] ?? "" }))
        : undefined,
      removedFavoriteIds: state.removed.length > 0 ? state.removed : undefined,
    };

    onConfirm(payload);
  };

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>Customize sidebar</DialogHeader>
      {/* Bleeds through the container's right padding (-mr-4/pr-4) so the scrollbar sits at the
          modal edge, and through the vertical grid gaps (-mt-1.25/-mb-4) so the scrollport (and
          scrollbar) starts at the header divider and ends at the footer border. pt-3/pb-3 are
          INSIDE the scrollport: resting gaps around the list that content scrolls through. */}
      <div className="-mb-4 -mr-4 -mt-1.25 max-h-[60vh] space-y-6 overflow-y-auto pb-3 pr-4 pt-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
        {orderedSections.map((section, index) => (
          <div key={section.id}>
            <div className="flex items-center justify-between border-b border-grid-dimmed pb-1.5">
              <Header3>{section.title}</Header3>
              <div className="flex items-center gap-0.5">
                <SectionMoveButton
                  label={`Move ${section.title} up`}
                  disabled={index === 0}
                  onClick={() => moveSection(section.id, -1)}
                >
                  <ArrowUpIcon className="size-3.5" />
                </SectionMoveButton>
                <SectionMoveButton
                  label={`Move ${section.title} down`}
                  disabled={index === orderedSections.length - 1}
                  onClick={() => moveSection(section.id, 1)}
                >
                  <ArrowDownIcon className="size-3.5" />
                </SectionMoveButton>
              </div>
            </div>
            <SectionItemList
              section={section}
              order={(state.itemOrders[section.id] ?? section.items.map((item) => item.id)).filter(
                (id) => !state.removed.includes(id)
              )}
              hidden={state.hidden}
              labels={state.labels}
              onReorder={(itemIds) => reorderItems(section.id, itemIds)}
              onToggleHidden={toggleHidden}
              onLabelChange={setLabel}
              onRemove={removeFavorite}
            />
          </div>
        ))}
      </div>
      {/* Negative margins stretch the top divider across the modal's full width */}
      <DialogFooter className="-mx-4 px-4">
        <div className="flex items-center gap-2">
          <DialogClose asChild>
            <Button variant="secondary/medium">Cancel</Button>
          </DialogClose>
          <Button variant="secondary/medium" onClick={reset}>
            Reset
          </Button>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          {confirmError && !isConfirming && (
            <FormError className="truncate">{confirmError}</FormError>
          )}
          <Button
            variant="primary/medium"
            onClick={confirm}
            disabled={hasBlankLabels}
            isLoading={isConfirming}
          >
            Confirm
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  );
}

function SectionMoveButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded text-text-dimmed transition-colors hover:bg-surface-control hover:text-text-bright focus-custom disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function SectionItemList({
  section,
  order,
  hidden,
  labels,
  onReorder,
  onToggleHidden,
  onLabelChange,
  onRemove,
}: {
  section: CustomizeSidebarSection;
  order: string[];
  hidden: Record<string, boolean>;
  labels: Record<string, string>;
  onReorder: (itemIds: string[]) => void;
  onToggleHidden: (itemId: string) => void;
  onLabelChange: (itemId: string, label: string) => void;
  onRemove: (itemId: string) => void;
}) {
  const { width, containerRef } = useContainerWidth({ initialWidth: 416 });

  const items = order
    .map((id) => section.items.find((item) => item.id === id))
    .filter((item): item is CustomizeSidebarItem => item !== undefined);

  const layout = items.map((item, index) => ({ i: item.id, x: 0, y: index, w: 1, h: 1 }));

  const handleDragStop = (nextLayout: Layout) => {
    const sorted = [...nextLayout].sort((a, b) => a.y - b.y).map((entry) => entry.i);
    if (!arraysEqual(sorted, order)) {
      onReorder(sorted);
    }
  };

  const renderRow = (item: CustomizeSidebarItem, options: { draggable: boolean }) => (
    <ModalItemRow
      item={item}
      isHidden={hidden[item.id] ?? false}
      label={labels[item.id]}
      draggable={options.draggable}
      onToggleHidden={() => onToggleHidden(item.id)}
      onLabelChange={(label) => onLabelChange(item.id, label)}
      onRemove={() => onRemove(item.id)}
    />
  );

  return (
    <div ref={containerRef as React.Ref<HTMLDivElement>}>
      {items.length >= 2 ? (
        <ReactGridLayout
          layout={layout}
          width={width}
          gridConfig={{
            cols: 1,
            rowHeight: ROW_HEIGHT,
            margin: [0, 0] as const,
            containerPadding: [0, 0] as const,
          }}
          resizeConfig={{ enabled: false }}
          dragConfig={{ enabled: true, handle: ".customize-drag-handle" }}
          onDragStop={handleDragStop}
          autoSize
        >
          {items.map((item) => (
            <div key={item.id}>{renderRow(item, { draggable: true })}</div>
          ))}
        </ReactGridLayout>
      ) : (
        items.map((item) => <div key={item.id}>{renderRow(item, { draggable: false })}</div>)
      )}
    </div>
  );
}

function ModalItemRow({
  item,
  isHidden,
  label,
  draggable,
  onToggleHidden,
  onLabelChange,
  onRemove,
}: {
  item: CustomizeSidebarItem;
  isHidden: boolean;
  label: string | undefined;
  draggable: boolean;
  onToggleHidden: () => void;
  onLabelChange: (label: string) => void;
  onRemove: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 border-b border-grid-dimmed"
      style={{ height: ROW_HEIGHT }}
    >
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 transition-opacity",
          isHidden && "opacity-50"
        )}
      >
        <Icon
          icon={item.icon}
          className={cn("size-5 shrink-0 text-text-dimmed", item.iconClassName)}
        />
        {item.isFavorite ? (
          <>
            <Input
              value={label ?? item.name}
              onChange={(e) => onLabelChange(e.target.value)}
              variant="medium"
              maxLength={64}
              containerClassName="max-w-60"
              aria-label={`Rename ${item.name}`}
            />
            {(label ?? item.name).trim().length === 0 && (
              <FormError className="shrink-0">Name can't be blank</FormError>
            )}
          </>
        ) : (
          <span className="truncate text-sm text-text-bright">{item.name}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {item.isFavorite && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${item.name}`}
            className="flex size-7 items-center justify-center rounded text-text-dimmed transition-colors hover:bg-error/10 hover:text-error focus-custom"
          >
            <CrossIcon className="size-4" />
          </button>
        )}
        <button
          type="button"
          onClick={onToggleHidden}
          aria-label={isHidden ? `Show ${item.name}` : `Hide ${item.name}`}
          aria-pressed={isHidden}
          className="flex size-7 items-center justify-center rounded text-text-dimmed transition-colors hover:bg-surface-control hover:text-text-bright focus-custom"
        >
          {isHidden ? <EyeClosedIcon className="size-4" /> : <EyeOpenIcon className="size-4" />}
        </button>
        {draggable ? (
          <div className="customize-drag-handle flex size-7 cursor-grab items-center justify-center rounded text-text-dimmed transition-colors hover:text-text-bright active:cursor-grabbing">
            <GripVerticalIcon className="size-4" />
          </div>
        ) : (
          <div className="size-7" />
        )}
      </div>
    </div>
  );
}
