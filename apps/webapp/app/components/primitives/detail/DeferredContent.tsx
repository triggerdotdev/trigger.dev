import { type ReactNode, Suspense, startTransition, useCallback, useEffect, useState } from "react";
import { TypedAwait } from "remix-typedjson";
import { ClientOnly } from "remix-utils/client-only";

/**
 * Renders a deferred loader value. Until it first resolves, `fallback` (a skeleton) shows. When
 * the loader runs again for the same `retainKey` (polling, a revalidation), the last value stays
 * on screen instead of flashing back to the skeleton; a new key (another tab, another page of
 * results) starts over with the skeleton.
 *
 * The Suspense boundary only exists in the browser; the server sends `fallback`. Detail pages
 * render tabs inside a resizable panel group that sets state synchronously while it measures
 * itself on mount, and a server-rendered boundary still waiting for its data would receive that
 * update before it finished hydrating and throw ("This Suspense boundary received an update
 * before it finished hydrating", React #421).
 */
export function DeferredContent<T>({
  resolve,
  fallback,
  errorElement,
  retainKey = "",
  children,
}: {
  resolve: Promise<T>;
  fallback: ReactNode;
  errorElement: ReactNode;
  retainKey?: string;
  children: (value: T) => ReactNode;
}) {
  const [last, setLast] = useState<{ key: string; value: T }>();
  const retained = last?.key === retainKey ? last : undefined;
  // A transition: storing the value must not interrupt this boundary while it is still hydrating.
  const remember = useCallback(
    (value: T) => startTransition(() => setLast({ key: retainKey, value })),
    [retainKey]
  );

  return (
    <ClientOnly fallback={fallback}>
      {() => (
        <Suspense fallback={retained ? children(retained.value) : fallback}>
          <TypedAwait resolve={resolve} errorElement={errorElement}>
            {(value) => (
              <Resolved value={value as T} onResolved={remember}>
                {children(value as T)}
              </Resolved>
            )}
          </TypedAwait>
        </Suspense>
      )}
    </ClientOnly>
  );
}

function Resolved<T>({
  value,
  onResolved,
  children,
}: {
  value: T;
  onResolved: (value: T) => void;
  children: ReactNode;
}) {
  useEffect(() => onResolved(value), [value, onResolved]);
  return children;
}
