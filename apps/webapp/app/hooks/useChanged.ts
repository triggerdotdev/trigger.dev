import { useEffect, useRef } from "react";

/** Call a function when the id of the item changes */
export function useChanged<T extends { id: string }>(
  getItem: () => T | undefined,
  action: (item: T | undefined) => void,
  sendInitialUndefined = true
) {
  const previousItemId = useRef<string | undefined>();
  const item = getItem();

  //when the value changes, call the action
  useEffect(() => {
    if (previousItemId.current !== item?.id) {
      action(item);
    }

    previousItemId.current = item?.id;
  }, [item]);

  //if sendInitialUndefined is true, call the action when the component first renders
  useEffect(() => {
    if (item !== undefined || sendInitialUndefined === false) return;
    action(item);
  }, []);
}
