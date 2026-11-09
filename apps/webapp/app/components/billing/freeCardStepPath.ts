import { organizationPath, type OrgForPath } from "~/utils/pathBuilder";

export function freeCardStepPath(organization: OrgForPath) {
  return `${organizationPath(organization)}/select-plan/card`;
}
