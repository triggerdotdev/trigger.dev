import { Form } from "@remix-run/react";
import { startTransition, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import {
  ComboBox,
  ComboboxProvider,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  SelectTrigger,
} from "~/components/primitives/Listbox";
import { allTaskRunStatuses, runStatusTitle } from "~/components/runs/v3/TaskRunStatus";

export default function Story() {
  return (
    <div className="flex h-full max-w-full flex-wrap items-start justify-start gap-2 px-4 py-16">
      <Form className="space-y-4">
        <div className="flex gap-16">
          <Filter />

          <Button variant="tertiary/small">Submit</Button>
        </div>
      </Form>
    </div>
  );
}

const filterTypes = [
  {
    name: "status",
    title: "Status",
  },
  { name: "environment", title: "Environment" },
];

type FilterType = (typeof filterTypes)[number]["name"];

function Filter() {
  const [searchValue, setSearchValue] = useState("");
  const shortcut = { key: "f" };

  return (
    <ComboboxProvider
      resetValueOnHide
      setValue={(value) => {
        startTransition(() => {
          setSearchValue(value);
        });
      }}
    >
      <SelectProvider
        virtualFocus={true}
        // value={value}
        setValue={(v) => {
          setSearchValue("");

          // if (setValue) {
          //   setValue(v as any);
          // }
        }}
        // defaultValue={defaultValue}
      >
        <SelectTrigger variant={"tertiary/small"} shortcut={shortcut} tooltipTitle={"Filter runs"}>
          Filter
        </SelectTrigger>
        <SelectPopover>
          <ComboBox placeholder={"Filter..."} shortcut={shortcut} value={searchValue} />
          <SelectList>
            <Menu searchValue={searchValue} />
          </SelectList>
        </SelectPopover>
      </SelectProvider>
    </ComboboxProvider>
  );
}

function Menu({ searchValue }: { searchValue: string }) {
  const [filterType, setFilterType] = useState<FilterType | undefined>();

  switch (filterType) {
    case undefined:
      return <MainMenu searchValue={searchValue} onSelected={setFilterType} />;
  }
  return <></>;
}

function MainMenu({
  searchValue,
  onSelected,
}: {
  searchValue: string;
  onSelected: (filterType: FilterType) => void;
}) {
  return (
    <SelectList>
      {filterTypes.map((type, index) => (
        <SelectItem
          key={type.name}
          onClick={(e) => {
            console.log("click", e);
          }}
        >
          {type.title}
        </SelectItem>
      ))}
    </SelectList>
  );
}

const statuses = allTaskRunStatuses.map((status) => ({
  title: runStatusTitle(status),
  value: status,
}));
