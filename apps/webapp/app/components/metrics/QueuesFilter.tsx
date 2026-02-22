import * as Ariakit from "@ariakit/react";
import { RectangleStackIcon } from "@heroicons/react/20/solid";
import { useFetcher } from "@remix-run/react";
import { matchSorter } from "match-sorter";
import { type ReactNode, useMemo } from "react";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import {
  ComboBox,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  SelectTrigger,
} from "~/components/primitives/Select";
import { Spinner } from "~/components/primitives/Spinner";
import { useDebounceEffect } from "~/hooks/useDebounce";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { type loader as queuesLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.queues";
import { appliedSummary, FilterMenuProvider } from "~/components/runs/v3/SharedFilters";

const shortcut = { key: "q" };

export function QueuesFilter() {
  const { values, replace, del } = useSearchParams();
  const selectedQueues = values("queues");

  if (selectedQueues.length === 0 || selectedQueues.every((v) => v === "")) {
    return (
      <FilterMenuProvider>
        {(search, setSearch) => (
          <QueuesDropdown
            trigger={
              <SelectTrigger
                icon={<RectangleStackIcon className="size-4" />}
                variant="secondary/small"
                shortcut={shortcut}
                tooltipTitle="Filter by queue"
              >
                <span className="ml-1">Queues</span>
              </SelectTrigger>
            }
            searchValue={search}
            clearSearchValue={() => setSearch("")}
          />
        )}
      </FilterMenuProvider>
    );
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <QueuesDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Queues"
                icon={<RectangleStackIcon className="size-4" />}
                value={appliedSummary(selectedQueues.map((v) => v.replace("task/", "")))}
                onRemove={() => del(["queues"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function QueuesDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({
      queues: values.length > 0 ? values : undefined,
    });
  };

  const queueValues = values("queues").filter((v) => v !== "");
  const selected = queueValues.length > 0 ? queueValues : undefined;

  const fetcher = useFetcher<typeof queuesLoader>();

  useDebounceEffect(
    searchValue,
    (s) => {
      const searchParams = new URLSearchParams();
      searchParams.set("per_page", "25");
      if (searchValue) {
        searchParams.set("query", s);
      }
      fetcher.load(
        `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${
          environment.slug
        }/queues?${searchParams.toString()}`
      );
    },
    250
  );

  const filtered = useMemo(() => {
    // Use a Map to deduplicate by value
    const itemsMap = new Map<string, { name: string; type: "custom" | "task"; value: string }>();

    // Add selected items first (for items not yet loaded from fetcher)
    for (const queueName of selected ?? []) {
      const queueItem = fetcher.data?.queues.find((q) => q.name === queueName);
      if (!queueItem) {
        if (queueName.startsWith("task/")) {
          itemsMap.set(queueName, {
            name: queueName.replace("task/", ""),
            type: "task",
            value: queueName,
          });
        } else {
          itemsMap.set(queueName, {
            name: queueName,
            type: "custom",
            value: queueName,
          });
        }
      }
    }

    // Add items from fetcher data
    if (fetcher.data !== undefined) {
      for (const q of fetcher.data.queues) {
        const value = q.type === "task" ? `task/${q.name}` : q.name;
        itemsMap.set(value, {
          name: q.name,
          type: q.type,
          value,
        });
      }
    }

    const items = Array.from(itemsMap.values());
    return matchSorter(items, searchValue, {
      keys: ["name"],
    });
  }, [searchValue, fetcher.data, selected]);

  return (
    <SelectProvider value={selected ?? []} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(360px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        <ComboBox
          value={searchValue}
          render={(props) => (
            <div className="flex items-center justify-stretch">
              <input {...props} placeholder={"Filter by queues..."} />
              {fetcher.state === "loading" && <Spinner color="muted" />}
            </div>
          )}
        />
        <SelectList>
          {filtered.length > 0
            ? filtered.map((queue) => (
                <SelectItem
                  key={queue.value}
                  value={queue.value}
                  icon={
                    queue.type === "task" ? (
                      <TaskIcon className="size-4 shrink-0 text-blue-500" />
                    ) : (
                      <RectangleStackIcon className="size-4 shrink-0 text-purple-500" />
                    )
                  }
                >
                  {queue.name}
                </SelectItem>
              ))
            : null}
          {filtered.length === 0 && fetcher.state !== "loading" && (
            <SelectItem disabled>No queues found</SelectItem>
          )}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}
