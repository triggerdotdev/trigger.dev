import { XMarkIcon } from "@heroicons/react/20/solid";
import { Form } from "@remix-run/react";
import { Button } from "~/components/primitives/Buttons";
import { SearchInput } from "~/components/primitives/SearchInput";
import { Select, SelectGroup, SelectGroupLabel, SelectItem } from "~/components/primitives/Select";
import { TimeFilter } from "~/components/runs/v3/SharedFilters";
import { useSearchParams } from "~/hooks/useSearchParam";
import type { AuditLogFilters } from "~/presenters/v3/AuditLogPresenter.server";
import type { AuditLogMenuEnvironment } from "~/presenters/v3/auditLogMenus.server";
import {
  ANY,
  AuditLogSearchMenu,
  CHIP_TRIGGER_CLASS,
  chipText,
  FilterChip,
} from "./AuditLogSearchMenu";
import {
  AUDIT_LOG_ACTION_LABELS,
  AUDIT_LOG_DEFAULT_PERIOD,
  AUDIT_LOG_FILTER_CATEGORIES,
  AUDIT_LOG_FILTER_CATEGORY_LABELS,
  AUDIT_LOG_VIA_LABELS,
  auditLogActions,
  ALL_AUDIT_LOG_ACTIONS,
  auditLogEventSections,
  type AuditLogEventChoice,
  DEFAULT_AUDIT_LOG_FILTER_CATEGORY,
  parseAuditLogActions,
} from "./auditLogEvents";

/** Params a new filter makes stale: the next page and the selected event. */
const RESET_PARAMS = { cursor: undefined, event: undefined };
/** The actor menu's "any key ending" item, followed by the last 4. */
const KEY_LAST4 = "last4:";
const isKeyLast4 = (value: string) => value.startsWith(KEY_LAST4);
const keyLast4Label = (last4: string) => `Any key ending ••••••••${last4}`;
/** A key or token, as the actor and credential menus name it; anything else is a person. */
const CREDENTIAL = /^(root|key|oat|pat):/;
/** A credential that belongs to a project, so picking another project unpicks it. */
const PROJECT_CREDENTIAL = /^(root|key):/;

export function AuditLogFilterBar({
  filters,
  selectedLabels,
}: {
  filters: AuditLogFilters;
  /** The picked values' names, which a menu's first page may not include. */
  selectedLabels: {
    actor?: string;
    place?: string;
    placeEnvironment?: AuditLogMenuEnvironment;
    credential?: string;
  };
}) {
  const { replace, has, values } = useSearchParams();

  const viaItems = [
    { value: ANY, label: "All" },
    ...Object.entries(AUDIT_LOG_VIA_LABELS).map(([value, label]) => ({ value, label })),
  ];

  // Nothing picked is the category's events, reads only for one key or token, as runs list every
  // status when none is picked. Picking narrows the list to exactly what's picked.
  const eventSections = auditLogEventSections(filters.category);
  const eventChoices = eventSections.flatMap((section) => section.items);
  // From the URL being navigated to, not the last loaded page, so a pick made while the previous
  // one loads adds to it.
  // The last `action` wins, as in the loader, for a link that repeats it.
  const pickedActions = parseAuditLogActions(values("action").at(-1), filters.category);
  // A choice is checked when any of its events is picked, e.g. a link to listings only.
  const pickedChoices = eventChoices.filter((choice) =>
    choice.actions.some((action) => pickedActions?.includes(action))
  );
  const offeredActions = auditLogActions(filters.category, true);
  const defaultActions = auditLogActions(filters.category, filters.includeReads);
  const pickChoices = (values: string[]) => {
    const actions = offeredActions.filter((action) =>
      eventChoices.some(
        (choice) =>
          values.includes(choice.value) &&
          choice.actions.includes(action) &&
          // A choice left as it was keeps the events it had, e.g. listings only from a link.
          (!pickedChoices.includes(choice) || (pickedActions?.includes(action) ?? false))
      )
    );
    // Picking exactly the default, e.g. every change after unticking reads, is the default.
    const isDefault =
      actions.length === defaultActions.length &&
      actions.every((action) => defaultActions.includes(action));
    replace({
      ...RESET_PARAMS,
      action:
        actions.length === 0 || isDefault
          ? undefined
          : actions.length === offeredActions.length
            ? ALL_AUDIT_LOG_ACTIONS
            : actions.join(","),
    });
  };
  // Shown like a set filter, as CloudTrail shows its default "Read-only: false": its ✕ clears it,
  // and every event is listed, reads included.
  const hidesReads =
    !pickedActions &&
    !filters.includeReads &&
    offeredActions.length > auditLogActions(filters.category, false).length;
  // Every event picked is no filter at all. Counted in events, not choices: listings without
  // value reads still checks the reads choice.
  const narrowed = pickedActions !== undefined && pickedActions.length < offeredActions.length;
  const eventsSet = hidesReads || narrowed;

  const isFiltered = [
    "category",
    "action",
    "actor",
    "credential",
    "via",
    "project",
    "environment",
    "target",
    "key",
    "period",
    "from",
    "to",
  ].some((param) => has(param));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <TimeFilter
        defaultPeriod={AUDIT_LOG_DEFAULT_PERIOD}
        labelName="Occurred"
        clearParams={["event"]}
        shortcut={{ key: "d" }}
      />
      <FilterChip
        isSet={filters.category !== DEFAULT_AUDIT_LOG_FILTER_CATEGORY}
        onClear={() => replace({ ...RESET_PARAMS, category: undefined, action: undefined })}
        clearLabel="Clear category filter"
      >
        <Select
          value={filters.category}
          shortcut={{ key: "c" }}
          tooltipTitle="Filter by category"
          setValue={(category) =>
            replace({
              ...RESET_PARAMS,
              category: category === DEFAULT_AUDIT_LOG_FILTER_CATEGORY ? undefined : category,
              // An event from another category would never match.
              action: undefined,
            })
          }
          items={AUDIT_LOG_FILTER_CATEGORIES.map((value) => ({
            value,
            label: AUDIT_LOG_FILTER_CATEGORY_LABELS[value],
          }))}
          text={(value) =>
            chipText(
              "Category",
              value === DEFAULT_AUDIT_LOG_FILTER_CATEGORY
                ? undefined
                : AUDIT_LOG_FILTER_CATEGORY_LABELS[
                    value as keyof typeof AUDIT_LOG_FILTER_CATEGORY_LABELS
                  ]
            )
          }
          dropdownIcon={filters.category === DEFAULT_AUDIT_LOG_FILTER_CATEGORY}
          variant={
            filters.category === DEFAULT_AUDIT_LOG_FILTER_CATEGORY
              ? "secondary/small"
              : "minimal/small"
          }
          className={
            filters.category === DEFAULT_AUDIT_LOG_FILTER_CATEGORY ? undefined : CHIP_TRIGGER_CLASS
          }
        >
          {(items) =>
            items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))
          }
        </Select>
      </FilterChip>
      <FilterChip
        isSet={eventsSet}
        onClear={() =>
          replace({ ...RESET_PARAMS, action: hidesReads ? ALL_AUDIT_LOG_ACTIONS : undefined })
        }
        clearLabel={hidesReads ? "Show environment variable reads" : "Clear event filter"}
      >
        <Select<string[], (typeof eventSections)[number]>
          value={pickedChoices.map((choice) => choice.value)}
          shortcut={{ key: "e" }}
          tooltipTitle="Filter by event"
          setValue={pickChoices}
          items={eventSections}
          // The merged reads choice is found by either event's name, as the list shows them.
          filter={(item, search) =>
            [item.label, ...item.actions.map((action) => AUDIT_LOG_ACTION_LABELS[action])].some(
              (label) => label.toLowerCase().includes(search.toLowerCase())
            )
          }
          heading="Filter by event…"
          // Kept while the menu is open: several events are often picked from one search.
          clearSearchOnSelection={false}
          text={() =>
            chipText(
              "Event",
              hidesReads
                ? "All except reads"
                : narrowed
                  ? eventsChipValue(pickedChoices)
                  : undefined
            )
          }
          dropdownIcon={!eventsSet}
          variant={eventsSet ? "minimal/small" : "secondary/small"}
          className={eventsSet ? CHIP_TRIGGER_CLASS : undefined}
          empty={<SelectItem disabled>No matches</SelectItem>}
        >
          {(items, { section }) => (
            <SelectGroup>
              {section?.title ? <SelectGroupLabel>{section.title}</SelectGroupLabel> : null}
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </Select>
      </FilterChip>
      <AuditLogSearchMenu
        menu="actor"
        label="Actor"
        shortcut={{ key: "a" }}
        heading="Filter by actor, or a key's last 4 characters…"
        project={filters.projectId}
        // Who acted: a person is the actor filter, a key or token the credential filter, and "any
        // key ending" the last 4 filter, which also finds events that changed the key.
        value={
          filters.actorId ??
          filters.credential ??
          (filters.keyLast4 ? `${KEY_LAST4}${filters.keyLast4}` : undefined)
        }
        selectedLabel={
          filters.actorId
            ? selectedLabels.actor
            : filters.credential
              ? selectedLabels.credential
              : filters.keyLast4
                ? keyLast4Label(filters.keyLast4)
                : undefined
        }
        anyLabel="All actors"
        // A former member stays filterable from a shared link.
        missingLabel={filters.actorId ? "Former member" : "Earlier credential"}
        onChange={(picked) =>
          replace({
            ...RESET_PARAMS,
            actor: picked && !CREDENTIAL.test(picked) && !isKeyLast4(picked) ? picked : undefined,
            credential: picked && CREDENTIAL.test(picked) ? picked : undefined,
            key: picked && isKeyLast4(picked) ? picked.slice(KEY_LAST4.length) : undefined,
          })
        }
      />
      <FilterChip
        isSet={Boolean(filters.via)}
        onClear={() => replace({ ...RESET_PARAMS, via: undefined })}
        clearLabel="Clear via filter"
      >
        <Select
          value={filters.via ?? ANY}
          shortcut={{ key: "v" }}
          tooltipTitle="Filter by how the request came in"
          setValue={(value) => replace({ ...RESET_PARAMS, via: value === ANY ? undefined : value })}
          items={viaItems}
          text={(value) =>
            chipText(
              "Via",
              value === ANY ? undefined : viaItems.find((item) => item.value === value)?.label
            )
          }
          dropdownIcon={!filters.via}
          variant={filters.via ? "minimal/small" : "secondary/small"}
          className={filters.via ? CHIP_TRIGGER_CLASS : undefined}
        >
          {(items) =>
            items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))
          }
        </Select>
      </FilterChip>
      <AuditLogSearchMenu
        menu="place"
        label="Project"
        shortcut={{ key: "p" }}
        heading="Filter by project…"
        project={filters.projectId}
        value={
          filters.environmentId
            ? `environment:${filters.projectId ?? ""}:${filters.environmentId}`
            : filters.projectId
              ? `project:${filters.projectId}`
              : undefined
        }
        selectedLabel={selectedLabels.place}
        selectedEnvironment={selectedLabels.placeEnvironment}
        anyLabel="All projects"
        missingLabel="Archived environment"
        onChange={(place) => {
          const [kind, project, environment] = place?.split(":") ?? [];
          replace({
            ...RESET_PARAMS,
            project: kind ? project : undefined,
            environment: kind === "environment" ? environment : undefined,
            // A key belongs to one project, so moving from one project to another unpicks a key
            // picked there. A key picked across all projects stays: it may be this project's.
            credential:
              filters.credential &&
              PROJECT_CREDENTIAL.test(filters.credential) &&
              filters.projectId &&
              project &&
              project !== filters.projectId
                ? undefined
                : filters.credential,
          });
        }}
      />
      <SearchInput
        paramName="target"
        placeholder="Exact target, e.g. API_KEY"
        resetParams={Object.keys(RESET_PARAMS)}
        focusedWidth="16rem"
      />
      {isFiltered ? (
        // As on the runs and logs pages: an empty form clears every filter, the time range too.
        <Form className="-ml-1 h-6">
          <Button
            variant="minimal/small"
            LeadingIcon={XMarkIcon}
            tooltip="Clear all filters"
            className="group-hover/button:bg-transparent"
            leadingIconClassName="group-hover/button:text-text-bright"
          />
        </Form>
      ) : null}
    </div>
  );
}

/** The event chip's value for picked events: one by name, several by count. */
function eventsChipValue(picked: AuditLogEventChoice[]): string {
  return picked.length === 1 ? picked[0]!.label : `${picked.length} events`;
}
