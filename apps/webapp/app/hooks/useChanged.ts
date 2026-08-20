import { useEffect, useRef } from "react";

/** Call a function when the id of the item changes */
export function useChanged<T extends { id: string }>(
  item: T | undefined,
  action: (item: T | undefined) => void,
  sendInitialUndefined = true
) {
  const previousItemId = useRef<string | undefined>();
  const isInitialRender = useRef(true);
  const actionRef = useRef(action);
  const itemRef = useRef<T | undefined>();
  const itemId = item?.id;

  // oxlint-disable-next-line react/react-compiler -- This ref intentionally coordinates an imperative integration outside React state.
  actionRef.current = action;
  // oxlint-disable-next-line react/react-compiler -- This ref intentionally coordinates an imperative integration outside React state.
  itemRef.current = item;

  useEffect(() => {
    const shouldSendInitialUndefined =
      isInitialRender.current && itemId === undefined && sendInitialUndefined;

    if (previousItemId.current !== itemId || shouldSendInitialUndefined) {
      actionRef.current(itemRef.current);
    }

    previousItemId.current = itemId;
    isInitialRender.current = false;
  }, [itemId, sendInitialUndefined]);
}
