import { useLocation, useNavigation } from "@remix-run/react";

export function usePathName(preemptive = true) {
  const navigation = useNavigation();
  const location = useLocation();

  if (!preemptive || navigation.state === "idle" || !navigation.location) {
    return location.pathname;
  }

  return navigation.location.pathname;
}
