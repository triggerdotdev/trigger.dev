import { useSyncExternalStore } from "react";
import { isLoaderDisconnected, subscribeToLoaderConnection } from "~/utils/loaderConnection";

export function useLoaderDisconnected() {
  return useSyncExternalStore(subscribeToLoaderConnection, isLoaderDisconnected, () => false);
}
