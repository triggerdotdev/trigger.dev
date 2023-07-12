import type { User } from "~/models/user.server";
import { useMatchesData } from "~/utils";
import { useChanged } from "./useChanged";
import { RouteMatch } from "@remix-run/react";
import { useTypedMatchesData } from "./useTypedMatchData";
import { loader } from "~/root";

export function useOptionalUser(matches?: RouteMatch[]): User | undefined {
  const routeMatch = useTypedMatchesData<typeof loader>({
    id: "root",
    matches,
  });

  return routeMatch?.user ?? undefined;
}

export function useUser(matches?: RouteMatch[]): User {
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
