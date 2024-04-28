import { useState, useTransition } from "react";
import {
  Combobox,
  ComboboxItem,
  ComboboxItemCheck,
  ComboboxPopover,
  ComboboxProvider,
} from "~/components/primitives/ComboBox";
import { Header1, Header2 } from "~/components/primitives/Headers";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/primitives/Select";
import { useTextFilter } from "~/hooks/useTextFilter";

const items = [
  "Apple",
  "Banana",
  "Cherry",
  "Date",
  "Elderberry",
  "Fig",
  "Grape",
  "Honeydew",
  "Kiwi",
  "Lemon",
  "Mango",
  "Nectarine",
  "Orange",
  "Peach",
  "Quince",
  "Raspberry",
  "Strawberry",
  "Tangerine",
  "Ugli fruit",
  "Vanilla bean",
  "Watermelon",
  "Ximenia",
  "Yuzu",
  "Zucchini",
];

export default function Story() {
  return (
    <div className="p-20">
      <div className="flex gap-8">
        <div className="flex flex-col">
          <Header1 className="mb-4">Variants</Header1>
          <Header2 className="my-4">size=small width=content</Header2>
          <TaskFilter />
        </div>
        <div>
          <SelectGroup>
            <Select name="fruit" defaultValue={items[0]}>
              <SelectTrigger>
                <SelectValue placeholder="Fruit" />
              </SelectTrigger>
              <SelectContent>
                {items.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SelectGroup>
        </div>
      </div>
    </div>
  );
}

function TaskFilter() {
  const [isPending, startTransition] = useTransition();
  const [selectedValues, setSelectedValues] = useState<string[]>([]);

  const { filterText, setFilterText, filteredItems } = useTextFilter({
    items,
    filter: (item, filterText) => {
      return item.toLowerCase().includes(filterText.toLowerCase());
    },
  });

  return (
    <ComboboxProvider
      selectedValue={selectedValues}
      setSelectedValue={setSelectedValues}
      setValue={(value) => {
        startTransition(() => {
          setFilterText(value);
        });
      }}
    >
      <Combobox placeholder="e.g., Apple, Burger" />
      <ComboboxPopover sameWidth gutter={8} aria-busy={isPending}>
        {filteredItems.map((item) => (
          <ComboboxItem key={item} value={item} focusOnHover>
            <ComboboxItemCheck />
            {item}
          </ComboboxItem>
        ))}
        {!filteredItems.length && <div className="no-results">No results found</div>}
      </ComboboxPopover>
    </ComboboxProvider>
  );
}
