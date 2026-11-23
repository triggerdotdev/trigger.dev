import { type ComponentProps, createElement, useEffect, useState } from "react";
import type ReactGridLayoutComponent from "react-grid-layout";

type GridLayout = typeof ReactGridLayoutComponent;

let loaded: GridLayout | undefined;
let loading: Promise<GridLayout> | undefined;

function loadGridLayout() {
  loading ??= import("react-grid-layout").then((module) => (loaded = module.default));
  return loading;
}

/**
 * react-grid-layout (with react-draggable and react-resizable) only matters once someone drags a
 * side menu item, so it loads after hydration instead of with every page. Until this returns true
 * the caller renders the same rows as a plain list.
 */
export function useGridLayoutReady(enabled: boolean): boolean {
  const [ready, setReady] = useState(() => loaded !== undefined);

  useEffect(() => {
    if (!enabled || ready) return;
    let cancelled = false;
    loadGridLayout().then(
      () => {
        if (!cancelled) setReady(true);
      },
      () => {}
    );
    return () => {
      cancelled = true;
    };
  }, [enabled, ready]);

  return ready;
}

/** Renders react-grid-layout once `useGridLayoutReady` has returned true. */
export function LoadedGridLayout(props: ComponentProps<GridLayout>) {
  return loaded ? createElement(loaded, props) : null;
}
