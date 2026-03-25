import { useEffect } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { useOrganization } from "~/hooks/useOrganizations";
import { type loader as canViewLogsPageLoader } from "~/routes/resources.orgs.$organizationSlug.can-view-logs-page/route";

export function useCanViewLogsPage(): boolean | undefined {
  const organization = useOrganization();
  const fetcher = useTypedFetcher<typeof canViewLogsPageLoader>();

  useEffect(() => {
    const url = `/resources/orgs/${organization.slug}/can-view-logs-page`;
    fetcher.load(url);
  }, [organization.slug]);

  return fetcher.data?.canViewLogsPage;
}
