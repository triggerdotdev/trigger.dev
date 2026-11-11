import { organizationPath, type OrgForPath } from "~/utils/pathBuilder";

/** Where the card step sends the user once they're done. Without one it's project creation. */
export type FreeCardReturnTo = "billing";

export const FREE_CARD_RETURN_TO_PARAM = "returnTo";

export function parseFreeCardReturnTo(value: unknown): FreeCardReturnTo | undefined {
  return value === "billing" ? value : undefined;
}

export function freeCardStepPath(organization: OrgForPath, returnTo?: FreeCardReturnTo) {
  const path = `${organizationPath(organization)}/select-plan/card`;
  return returnTo ? `${path}?${FREE_CARD_RETURN_TO_PARAM}=${returnTo}` : path;
}
