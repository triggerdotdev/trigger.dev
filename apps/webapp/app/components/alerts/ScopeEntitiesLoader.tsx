import { useInRouterContext } from "@remix-run/react";
import { useEffect, useRef, type ComponentProps } from "react";
import { storedQueueName } from "~/components/queues/queue-name";
import { useOptionalEnvironment } from "~/hooks/useEnvironment";
import { useOptionalOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject } from "~/hooks/useProject";
import { v3EnvironmentPath } from "~/utils/pathBuilder";

export type ScopeEntityKind = "queue" | "task";
export type ScopeEntities = { kind: ScopeEntityKind; names: string[] };

export function queueLabel(name: string): string {
  return name.replace(/^task\//, "");
}

type QueuesResponse = { queues?: { name: string; type: string }[]; hasMore?: boolean };
type TasksResponse = { tasks?: { slug: string }[] };

async function getJson<T>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

async function loadScopeEntities(
  base: string,
  kind: ScopeEntityKind,
  current?: string,
  search?: string
): Promise<string[]> {
  if (kind === "task") {
    const data = await getJson<TasksResponse>(`${base}/tasks`);
    return data?.tasks?.map((task) => task.slug) ?? [];
  }
  if (search) {
    const found = await getJson<QueuesResponse>(
      `${base}/queues?per_page=100&query=${encodeURIComponent(search)}`
    );
    const matches = found?.queues?.map(storedQueueName) ?? [];
    return current && !matches.includes(current) ? [...matches, current] : matches;
  }
  const data = await getJson<QueuesResponse>(`${base}/queues?per_page=100`);
  const names = data?.queues?.map(storedQueueName) ?? [];
  if (!current || names.includes(current) || !data?.hasMore) return names;
  const match = await getJson<QueuesResponse>(
    `${base}/queues?per_page=100&query=${encodeURIComponent(queueLabel(current))}`
  );
  return match?.queues?.some((queue) => storedQueueName(queue) === current)
    ? [current, ...names]
    : names;
}

function useResourceBase() {
  const organization = useOptionalOrganization();
  const project = useOptionalProject();
  const environment = useOptionalEnvironment();
  return organization && project && environment
    ? `/resources${v3EnvironmentPath(organization, project, environment)}`
    : undefined;
}

export type AreaAvailability = { base: string; empty: string[] };

async function loadEmptyAreas(base: string): Promise<string[]> {
  const [queues, tasks, errors] = await Promise.all([
    getJson<QueuesResponse>(`${base}/queues?per_page=1`),
    getJson<TasksResponse>(`${base}/tasks`),
    getJson<{ groups?: unknown[] }>(`${base}/alerts/error-groups`),
  ]);
  const empty: string[] = [];
  if (queues?.queues?.length === 0) empty.push("queues");
  if (tasks?.tasks?.length === 0) empty.push("runs");
  if (errors?.groups?.length === 0) empty.push("errors");
  return empty;
}

export function AreaAvailabilityLoader(props: ComponentProps<typeof LoadAreaAvailability>) {
  return useInRouterContext() ? <LoadAreaAvailability {...props} /> : null;
}

function LoadAreaAvailability({
  loaded,
  onLoad,
}: {
  loaded?: AreaAvailability;
  onLoad: (availability: AreaAvailability) => void;
}) {
  const base = useResourceBase();
  const loadedBase = loaded?.base;

  useEffect(() => {
    if (!base || loadedBase === base) return;
    let cancelled = false;
    void loadEmptyAreas(base).then((empty) => {
      if (!cancelled) onLoad({ base, empty });
    });
    return () => {
      cancelled = true;
    };
  }, [base, loadedBase, onLoad]);

  return null;
}

const SEARCH_DEBOUNCE_MS = 200;

export function ScopeEntitiesLoader({
  kind,
  current,
  search,
  onLoad,
}: {
  kind: ScopeEntityKind;
  current?: string;
  search?: string;
  onLoad: (entities: ScopeEntities) => void;
}) {
  const base = useResourceBase();
  const cache = useRef(new Map<string, string[]>());
  const emitted = useRef<string>();
  const query = kind === "queue" ? search?.trim() : undefined;

  useEffect(() => {
    if (!base) return;
    const key = `${base}:${kind}:${query ?? ""}`;
    const cached = cache.current.get(key);
    if (cached && (!current || cached.includes(current))) {
      if (emitted.current !== key) {
        emitted.current = key;
        onLoad({ kind, names: cached });
      }
      return;
    }
    let cancelled = false;
    const timer = setTimeout(
      () => {
        void loadScopeEntities(base, kind, current, query).then((names) => {
          if (cancelled) return;
          cache.current.set(key, names);
          emitted.current = key;
          onLoad({ kind, names });
        });
      },
      query ? SEARCH_DEBOUNCE_MS : 0
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [base, kind, current, query, onLoad]);

  return null;
}
