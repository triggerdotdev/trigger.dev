import { useLocation, useNavigation } from "@remix-run/react";

export function useOptimisticLocation() {
  const navigation = useNavigation();
  const location = useLocation();

  if (navigation.state === "idle" || !navigation.location) {
    return location;
  }

  return navigation.location;
}
