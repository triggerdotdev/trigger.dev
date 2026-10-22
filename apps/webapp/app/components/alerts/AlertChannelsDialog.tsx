import { useFetcher, useLocation } from "@remix-run/react";
import { useEffect } from "react";
import {
  AlertChannelsBody,
  type AlertChannelLimits,
  type AlertChannelRow,
  type ChannelFormState,
} from "~/components/alerts/AlertChannelsBody";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { v3ProjectAlertChannelsPath } from "~/utils/pathBuilder";

export type AlertChannelsData = {
  alertChannels: AlertChannelRow[];
  limits: AlertChannelLimits;
  canWrite: boolean;
  canDelete?: boolean;
  form?: ChannelFormState;
};

export function AlertChannelsDialog({
  open,
  data: initialData,
  onClose,
  onCreated,
}: {
  open: boolean;
  data?: AlertChannelsData;
  onClose: () => void;
  onCreated?: (channel: { id: string }) => void;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useLocation();
  const fetcher = useFetcher<AlertChannelsData>();
  const { load } = fetcher;
  const actionFetcher = useFetcher<{ error?: Record<string, string[] | null> | null }>();
  const actionError = actionFetcher.data?.error?.[""]?.[0];
  const channelsPath = v3ProjectAlertChannelsPath(organization, project, environment);

  useEffect(() => {
    if (open && !initialData) load(channelsPath);
  }, [open, initialData, channelsPath, load]);

  const data = fetcher.data ?? initialData;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[80vh] overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="px-4 pt-4">Channels</DialogHeader>
        {actionError && <Paragraph className="px-4 text-error">{actionError}</Paragraph>}
        <div className="max-h-[calc(80vh-4rem)] overflow-y-auto">
          {data ? (
            <AlertChannelsBody
              alertChannels={data.alertChannels}
              limits={data.limits}
              canWrite={data.canWrite}
              canDelete={data.canDelete}
              form={data.form}
              modal={{
                action: channelsPath,
                redirectTo: `${location.pathname}${location.search}`,
                fetcher: actionFetcher,
                reload: () => load(channelsPath),
                onCreated,
              }}
            />
          ) : (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
