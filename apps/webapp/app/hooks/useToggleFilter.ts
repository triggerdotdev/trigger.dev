import { useMemo, useState } from "react";

type ToggleFilterProps<T> = {
  items: T[];
  filter: (item: T, isToggleActive: boolean) => boolean;
  defaultValue?: boolean;
};

export function useToggleFilter<T>({ items, filter, defaultValue = false }: ToggleFilterProps<T>) {
  const [isToggleActive, setToggleActive] = useState(defaultValue);

  const filteredItems = useMemo<T[]>(() => {
    return items.filter((item) => filter(item, isToggleActive));
  }, [items, isToggleActive]);

  return {
    isToggleActive,
    setToggleActive,
    filteredItems,
  };
}
