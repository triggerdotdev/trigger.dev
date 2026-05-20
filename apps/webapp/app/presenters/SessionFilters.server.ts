import {
  getSessionFiltersFromSearchParams,
  SessionListSearchFilters,
} from "~/components/sessions/v1/SessionFilters";
import { type SessionStatus } from "~/services/sessionsRepository/sessionsRepository.server";

export type SessionFiltersFromRequest = SessionListSearchFilters & {
  statuses?: SessionStatus[];
};

export function getSessionFiltersFromRequest(request: Request): SessionFiltersFromRequest {
  const url = new URL(request.url);
  const s = getSessionFiltersFromSearchParams(url.searchParams);
  return {
    ...s,
    statuses: s.statuses as SessionStatus[] | undefined,
  };
}
