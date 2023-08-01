import { useMemo, useState } from "react";

type TextFilterProps<T> = {
  defaultValue?: string;
  items: T[];
  filter: (item: T, filterText: string) => boolean;
};

export function useTextFilter<T>({ defaultValue = "", items, filter }: TextFilterProps<T>) {
  const [filterText, setFilterText] = useState(defaultValue);

  const filteredItems = useMemo<T[]>(() => {
    if (filterText === "") {
      return items;
    }
    return items.filter((item) => {
      return filter(item, filterText);
    });
  }, [items, filterText]);

  return {
    filterText,
    setFilterText,
    filteredItems,
  };
}
