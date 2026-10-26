import { useFetcher } from "@remix-run/react";
import { useEffect } from "react";
import { AlertChannelForm } from "~/components/alerts/AlertChannelForm";
import { alertChannelsResourcePath } from "~/components/alerts/alertChannelsResourcePath";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { v3ProjectAlertChannelsPath } from "~/utils/pathBuilder";

export function AddChannelSection({
  form,
  onCreated,
  defaultType = "EMAIL",
  connectReturnTo,
  onConnect,
}: {
  form: Pick<React.ComponentProps<typeof AlertChannelForm>, "slack" | "emailAlertsEnabled">;
  onCreated: (channel: { id: string }) => void;
  defaultType?: "EMAIL" | "SLACK";
  connectReturnTo?: string;
  onConnect?: () => void;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const fetcher = useFetcher<{ channel?: { id: string } }>();
  const created = fetcher.data?.channel;

  useEffect(() => {
    if (created) onCreated(created);
  }, [created]); // eslint-disable-line react-hooks/exhaustive-deps -- fire once per created channel

  return (
    <div className="flex flex-col gap-3 p-4">
      <AlertChannelForm
        inline
        mode="create"
        slack={form.slack}
        emailAlertsEnabled={form.emailAlertsEnabled}
        defaultType={defaultType}
        connectReturnTo={
          connectReturnTo ??
          `${v3ProjectAlertChannelsPath(organization, project, environment)}?add=slack`
        }
        onConnect={onConnect}
        fetcher={fetcher}
        action={alertChannelsResourcePath(project.id)}
      />
    </div>
  );
}
