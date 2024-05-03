import { CpuChipIcon } from "@heroicons/react/20/solid";
import { CircleStackIcon } from "@heroicons/react/24/outline";
import { Form, useNavigate } from "@remix-run/react";
import { startTransition, useCallback, useMemo, useState } from "react";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Button } from "~/components/primitives/Buttons";
import {
  ComboBox,
  ComboboxProvider,
  SelectButtonItem,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  SelectTrigger,
  shortcutFromIndex,
} from "~/components/primitives/Listbox";
import {
  TaskRunStatusCombo,
  allTaskRunStatuses,
  runStatusTitle,
} from "~/components/runs/v3/TaskRunStatus";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { ShortcutDefinition } from "~/hooks/useShortcutKeys";

export default function Story() {
  return (
    <div className="flex h-full max-w-full flex-wrap items-start justify-start gap-2 px-8 py-16">
      <Form className="space-y-4">
        <div className="flex gap-16">
          <Filter />
        </div>
      </Form>
    </div>
  );
}

const filterTypes = [
  {
    name: "status",
    title: "Status",
    icon: <CircleStackIcon className="h-4 w-4" />,
  },
  { name: "environment", title: "Environment", icon: <CpuChipIcon className="h-4 w-4" /> },
];

type FilterType = (typeof filterTypes)[number]["name"];

function Filter() {
  const [filterType, setFilterType] = useState<FilterType | undefined>();
  const [searchValue, setSearchValue] = useState("");
  const shortcut = { key: "f" };

  const clearSearchValue = useCallback(() => {
    setSearchValue("");
  }, [setSearchValue]);

  const filterTrigger = (
    <SelectTrigger variant={"tertiary/small"} shortcut={shortcut} tooltipTitle={"Filter runs"}>
      Filter
    </SelectTrigger>
  );

  return (
    <ComboboxProvider
      resetValueOnHide
      setValue={(value) => {
        startTransition(() => {
          setSearchValue(value);
        });
      }}
      setOpen={(open) => {
        if (!open) {
          setFilterType(undefined);
        }
      }}
    >
      <Menu
        searchValue={searchValue}
        clearSearchValue={clearSearchValue}
        shortcut={shortcut}
        trigger={filterTrigger}
        filterType={filterType}
        setFilterType={setFilterType}
      />
    </ComboboxProvider>
  );
}

type MenuProps = {
  searchValue: string;
  clearSearchValue: () => void;
  shortcut: ShortcutDefinition;
  trigger: React.ReactNode;
};

function Menu({
  filterType,
  setFilterType,
  ...props
}: MenuProps & {
  filterType: FilterType | undefined;
  setFilterType: (filterType: FilterType) => void;
}) {
  switch (filterType) {
    case undefined:
      return <MainMenu {...props} onSelected={setFilterType} />;
    case "status":
      return <Statuses {...props} />;
    case "environment":
      return <Environments {...props} />;
  }
  return <></>;
}

function MainMenu({
  searchValue,
  clearSearchValue,
  onSelected,
  trigger,
  shortcut,
}: {
  onSelected: (filterType: FilterType) => void;
} & MenuProps) {
  const filtered = useMemo(() => {
    return filterTypes.filter((item) =>
      item.title.toLowerCase().includes(searchValue.toLowerCase())
    );
  }, [searchValue]);

  return (
    <SelectProvider virtualFocus={true}>
      {trigger}
      <SelectPopover>
        <ComboBox placeholder={"Filter..."} shortcut={shortcut} value={searchValue} />
        <SelectList>
          {filtered.map((type, index) => (
            <SelectButtonItem
              key={type.name}
              onClick={() => {
                clearSearchValue();
                onSelected(type.name);
              }}
              icon={type.icon}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              {type.title}
            </SelectButtonItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

const statuses = allTaskRunStatuses.map((status) => ({
  title: runStatusTitle(status),
  value: status,
}));

function Statuses({ trigger, clearSearchValue, shortcut, searchValue }: MenuProps) {
  const navigate = useNavigate();
  const location = useOptimisticLocation();
  const search = new URLSearchParams(location.search);

  const handleChange = useCallback((values: string[]) => {
    clearSearchValue();

    search.delete("status");
    for (const value of values) {
      search.append("status", value);
    }
    navigate(`${location.pathname}?${search.toString()}`, { replace: true });
  }, []);

  const filtered = useMemo(() => {
    return statuses.filter((item) => item.title.toLowerCase().includes(searchValue.toLowerCase()));
  }, [searchValue]);

  return (
    <SelectProvider value={search.getAll("status")} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover>
        <ComboBox placeholder={"Filter by status..."} shortcut={shortcut} value={searchValue} />
        <SelectList>
          {filtered.map((item, index) => (
            <SelectItem
              key={item.value}
              value={item.value}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              <TaskRunStatusCombo status={item.value} iconClassName="animate-none" />
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

const environments = [
  {
    type: "DEVELOPMENT" as const,
  },
  {
    type: "STAGING" as const,
  },
  {
    type: "PRODUCTION" as const,
  },
];

function Environments({ trigger, clearSearchValue, shortcut, searchValue }: MenuProps) {
  const navigate = useNavigate();
  const location = useOptimisticLocation();
  const search = new URLSearchParams(location.search);

  const handleChange = useCallback((values: string[]) => {
    clearSearchValue();

    search.delete("environment");
    for (const value of values) {
      search.append("environment", value);
    }
    navigate(`${location.pathname}?${search.toString()}`, { replace: true });
  }, []);

  const filtered = useMemo(() => {
    return environments.filter((item) =>
      item.type.toLowerCase().includes(searchValue.toLowerCase())
    );
  }, [searchValue]);

  return (
    <SelectProvider
      value={search.getAll("environment")}
      setValue={handleChange}
      virtualFocus={true}
    >
      {trigger}
      <SelectPopover>
        <ComboBox
          placeholder={"Filter by environment..."}
          shortcut={shortcut}
          value={searchValue}
        />
        <SelectList>
          {filtered.map((item, index) => (
            <SelectItem
              key={item.type}
              value={item.type}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              <EnvironmentLabel environment={item} />
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}
