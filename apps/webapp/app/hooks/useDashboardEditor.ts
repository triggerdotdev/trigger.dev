import { useReducer, useCallback, useRef, useEffect } from "react";
import { nanoid } from "nanoid";
import type {
  DashboardLayout,
  LayoutItem,
  Widget,
} from "~/presenters/v3/MetricDashboardPresenter.server";
import type { WidgetData, QueryWidgetConfig } from "~/components/metrics/QueryWidget";

// ============================================================================
// Types
// ============================================================================

type EditorMode =
  | null
  | { type: "add" }
  | { type: "edit"; widgetId: string; widget: WidgetData };

type DashboardState = {
  /** The layout items (positions/sizes) */
  layout: LayoutItem[];
  /** The widget configurations keyed by widget ID */
  widgets: Record<string, Widget>;
  /** Current editor mode (add/edit/closed) */
  editorMode: EditorMode;
};

// ============================================================================
// Actions
// ============================================================================

type DashboardAction =
  | { type: "ADD_WIDGET"; payload: { id: string; widget: Widget; layoutItem: LayoutItem } }
  | { type: "UPDATE_WIDGET"; payload: { id: string; widget: Widget } }
  | { type: "DELETE_WIDGET"; payload: { id: string } }
  | { type: "DUPLICATE_WIDGET"; payload: { id: string; newId: string } }
  | { type: "UPDATE_LAYOUT"; payload: { layout: LayoutItem[] } }
  | { type: "RESET_STATE"; payload: { layout: LayoutItem[]; widgets: Record<string, Widget> } }
  | { type: "OPEN_ADD_EDITOR" }
  | { type: "OPEN_EDIT_EDITOR"; payload: { widgetId: string; widget: WidgetData } }
  | { type: "CLOSE_EDITOR" };

// ============================================================================
// Reducer
// ============================================================================

function dashboardReducer(state: DashboardState, action: DashboardAction): DashboardState {
  switch (action.type) {
    case "ADD_WIDGET":
      return {
        ...state,
        layout: [...state.layout, action.payload.layoutItem],
        widgets: {
          ...state.widgets,
          [action.payload.id]: action.payload.widget,
        },
        editorMode: null,
      };

    case "UPDATE_WIDGET":
      return {
        ...state,
        widgets: {
          ...state.widgets,
          [action.payload.id]: action.payload.widget,
        },
        editorMode: null,
      };

    case "DELETE_WIDGET": {
      const { [action.payload.id]: _, ...remainingWidgets } = state.widgets;
      return {
        ...state,
        layout: state.layout.filter((item) => item.i !== action.payload.id),
        widgets: remainingWidgets,
      };
    }

    case "DUPLICATE_WIDGET": {
      const original = state.widgets[action.payload.id];
      const originalLayout = state.layout.find((l) => l.i === action.payload.id);
      if (!original || !originalLayout) return state;

      const maxBottom = Math.max(0, ...state.layout.map((l) => l.y + l.h));

      // Deep copy the widget to ensure no shared references
      // This prevents edits to one widget from affecting the duplicate
      const duplicatedWidget: Widget = {
        title: `${original.title} (Copy)`,
        query: original.query,
        display: JSON.parse(JSON.stringify(original.display)) as QueryWidgetConfig,
      };

      return {
        ...state,
        layout: [
          ...state.layout,
          { ...originalLayout, i: action.payload.newId, y: maxBottom, x: 0 },
        ],
        widgets: {
          ...state.widgets,
          [action.payload.newId]: duplicatedWidget,
        },
      };
    }

    case "UPDATE_LAYOUT":
      return { ...state, layout: action.payload.layout };

    case "RESET_STATE":
      return {
        ...state,
        layout: action.payload.layout,
        widgets: action.payload.widgets,
      };

    case "OPEN_ADD_EDITOR":
      return { ...state, editorMode: { type: "add" } };

    case "OPEN_EDIT_EDITOR":
      return {
        ...state,
        editorMode: { type: "edit", widgetId: action.payload.widgetId, widget: action.payload.widget },
      };

    case "CLOSE_EDITOR":
      return { ...state, editorMode: null };

    default:
      return state;
  }
}

// ============================================================================
// Hook Options
// ============================================================================

export type UseDashboardEditorOptions = {
  /** Initial dashboard layout data from the server */
  initialData: DashboardLayout;
  /** URL for widget actions (add, update, delete, duplicate) */
  widgetActionUrl: string;
  /** URL for layout updates. If empty or not provided, uses current page URL. */
  layoutActionUrl?: string;
  /** Callback when a sync error occurs */
  onSyncError?: (error: Error, action: string) => void;
};

// ============================================================================
// Sync Queue Types
// ============================================================================

type WidgetSyncTask = {
  type: "widget";
  action: string;
  data: Record<string, string>;
};

type LayoutSyncTask = {
  type: "layout";
  layout: LayoutItem[];
};

type SyncTask = WidgetSyncTask | LayoutSyncTask;

// ============================================================================
// Hook
// ============================================================================

export function useDashboardEditor({
  initialData,
  widgetActionUrl,
  layoutActionUrl,
  onSyncError,
}: UseDashboardEditorOptions) {
  const [state, dispatch] = useReducer(dashboardReducer, {
    layout: initialData.layout,
    widgets: initialData.widgets,
    editorMode: null,
  });

  // Refs for debouncing and tracking initialization
  const layoutDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInitializedRef = useRef(false);
  const currentLayoutJsonRef = useRef<string>(JSON.stringify(initialData.layout));

  // Sync queue to prevent race conditions
  const syncQueueRef = useRef<SyncTask[]>([]);
  const isSyncingRef = useRef(false);

  // Reset state when initialData changes (e.g., navigating to different dashboard)
  const initialDataJson = JSON.stringify({ layout: initialData.layout, widgets: initialData.widgets });
  useEffect(() => {
    // Cancel any pending layout save
    if (layoutDebounceRef.current) {
      clearTimeout(layoutDebounceRef.current);
      layoutDebounceRef.current = null;
    }

    // Clear the sync queue when switching dashboards
    syncQueueRef.current = [];

    // Reset state to new initial data
    dispatch({
      type: "RESET_STATE",
      payload: { layout: initialData.layout, widgets: initialData.widgets },
    });

    // Update refs
    currentLayoutJsonRef.current = JSON.stringify(initialData.layout);
    isInitializedRef.current = false;

    // Allow saves after a short delay to skip initial mount callbacks
    const initTimeout = setTimeout(() => {
      isInitializedRef.current = true;
    }, 100);

    return () => {
      clearTimeout(initTimeout);
      if (layoutDebounceRef.current) {
        clearTimeout(layoutDebounceRef.current);
      }
    };
  }, [initialDataJson]);

  // -------------------------------------------------------------------------
  // Sync queue processor - ensures only one sync runs at a time
  // -------------------------------------------------------------------------

  const processNextSync = useCallback(async () => {
    // If already syncing or queue is empty, do nothing
    if (isSyncingRef.current || syncQueueRef.current.length === 0) {
      return;
    }

    isSyncingRef.current = true;
    const task = syncQueueRef.current.shift()!;

    try {
      if (task.type === "widget") {
        const formData = new FormData();
        formData.set("action", task.action);
        Object.entries(task.data).forEach(([k, v]) => formData.set(k, v));

        const response = await fetch(widgetActionUrl, {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to ${task.action} widget: ${errorText}`);
        }
      } else if (task.type === "layout") {
        const formData = new FormData();
        formData.set("action", "layout");
        formData.set("layout", JSON.stringify(task.layout));

        // Use current page URL if layoutActionUrl is not provided
        const url = layoutActionUrl || window.location.pathname;

        const response = await fetch(url, {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error("Failed to update layout: " + errorText);
        }
      }
    } catch (error) {
      console.error(`Dashboard sync error:`, error);
      const actionName = task.type === "widget" ? task.action : "layout";
      onSyncError?.(error instanceof Error ? error : new Error(String(error)), actionName);
    } finally {
      isSyncingRef.current = false;
      // Process next item in queue
      processNextSync();
    }
  }, [widgetActionUrl, layoutActionUrl, onSyncError]);

  // -------------------------------------------------------------------------
  // Queue helpers
  // -------------------------------------------------------------------------

  const queueWidgetSync = useCallback(
    (action: string, data: Record<string, string>) => {
      syncQueueRef.current.push({ type: "widget", action, data });
      processNextSync();
    },
    [processNextSync]
  );

  const queueLayoutSync = useCallback(
    (layout: LayoutItem[]) => {
      // For layout syncs, we only care about the latest state
      // Remove any pending layout syncs and add the new one
      syncQueueRef.current = syncQueueRef.current.filter((task) => task.type !== "layout");
      syncQueueRef.current.push({ type: "layout", layout });
      processNextSync();
    },
    [processNextSync]
  );

  // -------------------------------------------------------------------------
  // Action handlers
  // -------------------------------------------------------------------------

  const addWidget = useCallback(
    (title: string, query: string, config: QueryWidgetConfig) => {
      const id = nanoid(8);
      const maxBottom = Math.max(0, ...state.layout.map((l) => l.y + l.h));
      const layoutItem: LayoutItem = { i: id, x: 0, y: maxBottom, w: 12, h: 15 };
      const widget: Widget = { title, query, display: config };

      // Update local state immediately
      dispatch({ type: "ADD_WIDGET", payload: { id, widget, layoutItem } });

      // Queue sync to server (processed sequentially)
      queueWidgetSync("add", {
        title,
        query,
        config: JSON.stringify(config),
      });
    },
    [state.layout, queueWidgetSync]
  );

  const updateWidget = useCallback(
    (widgetId: string, title: string, query: string, config: QueryWidgetConfig) => {
      const widget: Widget = { title, query, display: config };

      // Update local state immediately
      dispatch({ type: "UPDATE_WIDGET", payload: { id: widgetId, widget } });

      // Queue sync to server (processed sequentially)
      queueWidgetSync("update", {
        widgetId,
        title,
        query,
        config: JSON.stringify(config),
      });
    },
    [queueWidgetSync]
  );

  const deleteWidget = useCallback(
    (widgetId: string) => {
      // Update local state immediately
      dispatch({ type: "DELETE_WIDGET", payload: { id: widgetId } });

      // Queue sync to server (processed sequentially)
      queueWidgetSync("delete", { widgetId });
    },
    [queueWidgetSync]
  );

  const duplicateWidget = useCallback(
    (widgetId: string) => {
      const newId = nanoid(8);

      // Update local state immediately
      dispatch({ type: "DUPLICATE_WIDGET", payload: { id: widgetId, newId } });

      // Queue sync to server (processed sequentially)
      // Note: Server will generate its own ID, but our local state uses newId
      // This is fine since we're optimistic - the server state will be consistent
      queueWidgetSync("duplicate", { widgetId });
    },
    [queueWidgetSync]
  );

  const updateLayout = useCallback(
    (newLayout: LayoutItem[]) => {
      // Skip if not yet initialized (prevents saving during mount/navigation)
      if (!isInitializedRef.current) {
        return;
      }

      const newLayoutJson = JSON.stringify(newLayout);

      // Skip if layout hasn't actually changed
      if (newLayoutJson === currentLayoutJsonRef.current) {
        return;
      }

      // Update local state immediately
      dispatch({ type: "UPDATE_LAYOUT", payload: { layout: newLayout } });

      // Clear existing debounce timeout
      if (layoutDebounceRef.current) {
        clearTimeout(layoutDebounceRef.current);
      }

      // Debounce before queueing - this ensures rapid layout changes
      // (like dragging) don't queue up many requests
      layoutDebounceRef.current = setTimeout(() => {
        currentLayoutJsonRef.current = newLayoutJson;
        // Queue layout sync (replaces any pending layout sync in queue)
        queueLayoutSync(newLayout);
      }, 500);
    },
    [queueLayoutSync]
  );

  const openAddEditor = useCallback(() => {
    dispatch({ type: "OPEN_ADD_EDITOR" });
  }, []);

  const openEditEditor = useCallback((widgetId: string, widget: WidgetData) => {
    dispatch({ type: "OPEN_EDIT_EDITOR", payload: { widgetId, widget } });
  }, []);

  const closeEditor = useCallback(() => {
    dispatch({ type: "CLOSE_EDITOR" });
  }, []);

  // -------------------------------------------------------------------------
  // Return value
  // -------------------------------------------------------------------------

  return {
    /** Current dashboard state */
    state,
    /** Action dispatchers */
    actions: {
      addWidget,
      updateWidget,
      deleteWidget,
      duplicateWidget,
      updateLayout,
      openAddEditor,
      openEditEditor,
      closeEditor,
    },
  };
}
