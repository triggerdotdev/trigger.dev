import { type UIMatch } from "@remix-run/react";
import type { UserWithDashboardPreferences } from "~/models/user.server";
import { type loader } from "~/root";
import { useChanged } from "./useChanged";
import { useTypedMatchesData } from "./useTypedMatchData";
import { useIsImpersonating } from "./useOrganizations";

export type User = UserWithDashboardPreferences;

export function useOptionalUser(matches?: UIMatch[]): User | undefined {
  const routeMatch = useTypedMatchesData<typeof loader>({
    id: "root",
    matches,
  });

  return routeMatch?.user ?? undefined;
}

export function useUser(matches?: UIMatch[]): User {
  const maybeUser = useOptionalUser(matches);
  if (!maybeUser) {
    throw new Error(
      "No user found in root loader, but user is required by useUser. If user is optional, try useOptionalUser instead."
    );
  }
  return maybeUser;
}

export function useUserChanged(callback: (user: User | undefined) => void) {
  useChanged(useOptionalUser, callback);
}

export function useHasAdminAccess(matches?: UIMatch[]): boolean {
  const user = useOptionalUser(matches);
  const isImpersonating = useIsImpersonating(matches);

  return Boolean(user?.admin) || isImpersonating;
}
