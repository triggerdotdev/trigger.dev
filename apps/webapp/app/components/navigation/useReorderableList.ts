import { useFetcher } from "@remix-run/react";
import { type Ref, useCallback, useEffect, useMemo, useState } from "react";
import { type Layout, useContainerWidth } from "react-grid-layout";

/**
 * Generic hook for managing a reorderable list in the side menu.
 *
 * Handles order state, sorting, grid layout, drag callbacks, and persistence
 * via the `/resources/preferences/sidemenu` resource route.
 *
 * @param organizationId - Organization ID for scoping the persisted order
 * @param listId - Identifier for this list (e.g. "customDashboards")
 * @param items - The items to reorder
 * @param itemKey - Extract a stable string key from each item
 * @param initialOrder - Initial order from stored preferences (if any)
 * @param isImpersonating - Skip persistence when impersonating
 */
export function useReorderableList<T>({
  organizationId,
  listId,
  items,
  itemKey,
  initialOrder,
  isImpersonating,
}: {
  organizationId: string;
  listId: string;
  items: T[];
  itemKey: (item: T) => string;
  initialOrder: string[] | undefined;
  isImpersonating: boolean;
}) {
  const orderFetcher = useFetcher();

  const [order, setOrder] = useState<string[]>(
    () => initialOrder ?? items.map(itemKey)
  );

  // Sync order when organizationId changes (component may not remount)
  useEffect(() => {
    setOrder(initialOrder ?? items.map(itemKey));
  }, [organizationId]);

  // Sort items by stored order, new items go to end
  const orderedItems = useMemo(() => {
    const orderMap = new Map(order.map((id, i) => [id, i]));
    return [...items].sort((a, b) => {
      const aIdx = orderMap.get(itemKey(a)) ?? Infinity;
      const bIdx = orderMap.get(itemKey(b)) ?? Infinity;
      return aIdx - bIdx;
    });
  }, [items, order, itemKey]);

  // Layout for ReactGridLayout (1-column vertical list, each item h=1 row)
  const layout = useMemo(
    () =>
      orderedItems.map((item, i) => ({
        i: itemKey(item),
        x: 0,
        y: i,
        w: 1,
        h: 1,
      })),
    [orderedItems, itemKey]
  );

  // Width measurement for ReactGridLayout
  const {
    width: gridWidth,
    containerRef,
    mounted: gridMounted,
  } = useContainerWidth({ initialWidth: 216 });

  const canReorder = orderedItems.length >= 2;

  // Track layout during drag for real-time visual updates
  const [dragLayout, setDragLayout] = useState<Layout | null>(null);

  const handleDrag = useCallback((layout: Layout) => {
    setDragLayout(layout);
  }, []);

  // Handle drag stop - extract new order from layout y-positions
  const handleDragStop = useCallback(
    (layout: Layout) => {
      setDragLayout(null);
      const sorted = [...layout].sort((a, b) => a.y - b.y);
      const newOrder = sorted.map((item) => item.i);
      if (JSON.stringify(newOrder) === JSON.stringify(order)) return;
      setOrder(newOrder);
      // Persist immediately
      if (!isImpersonating) {
        const formData = new FormData();
        formData.append("organizationId", organizationId);
        formData.append("listId", listId);
        formData.append("itemOrder", JSON.stringify(newOrder));
        orderFetcher.submit(formData, {
          method: "POST",
          action: "/resources/preferences/sidemenu",
        });
      }
    },
    [order, organizationId, listId, isImpersonating, orderFetcher]
  );

  // Compute which item is visually last (during drag or at rest)
  const getIsLast = useCallback(
    (key: string, index: number) => {
      if (dragLayout) {
        const maxY = Math.max(...dragLayout.map((l) => l.y));
        return dragLayout.find((l) => l.i === key)?.y === maxY;
      }
      return index === orderedItems.length - 1;
    },
    [dragLayout, orderedItems.length]
  );

  return {
    orderedItems,
    layout,
    containerRef: containerRef as Ref<HTMLDivElement>,
    gridWidth,
    gridMounted,
    canReorder,
    handleDrag,
    handleDragStop,
    getIsLast,
  };
}
