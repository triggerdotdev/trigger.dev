import { useLocation, useNavigation } from "@remix-run/react";

export function useOptimisticLocation() {
  const navigation = useNavigation();
  const location = useLocation();

  // Only follow a pending navigation that stays on this page (e.g. a filter change). Leaving the
  // page keeps the current location, so filters and tabs don't flash back to their defaults.
  if (
    navigation.state === "idle" ||
    !navigation.location ||
    navigation.location.pathname !== location.pathname
  ) {
    return location;
  }

  return navigation.location;
}
