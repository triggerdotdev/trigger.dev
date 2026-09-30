import { useFetcher } from "@remix-run/react";
import { useEffect } from "react";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { RelativeDateTime } from "~/components/primitives/DateTime";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "~/components/primitives/Dialog";
import { FormError } from "~/components/primitives/FormError";
import { Hint } from "~/components/primitives/Hint";
import { Label } from "~/components/primitives/Label";
import { TextArea } from "~/components/primitives/TextArea";
import type {
  SupportAccessDialogActionData,
  SupportAccessDialogData,
} from "~/routes/admin.api.v2.orgs.$organizationId.support-access";

type SupportAccessRequestDialogProps = {
  org: { id: string; title: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SupportAccessRequestDialog({
  org,
  open,
  onOpenChange,
}: SupportAccessRequestDialogProps) {
  const loadFetcher = useFetcher<SupportAccessDialogData>();
  const submitFetcher = useFetcher<SupportAccessDialogActionData>();
  const load = loadFetcher.load;
  const endpoint = org ? `/admin/api/v2/orgs/${org.id}/support-access` : undefined;

  useEffect(() => {
    if (open && endpoint) {
      load(endpoint);
    }
  }, [load, open, endpoint]);

  if (!org) return null;

  const result = submitFetcher.data;
  const created = result?.success ? result : undefined;
  const error = result && !result.success ? result.error : undefined;
  const isSubmitting = submitFetcher.state !== "idle";

  if (created) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>Request created - {org.title}</DialogHeader>
          <DialogDescription>
            We don't email the org. Send this link to an Owner or Admin of {org.title} so they can
            approve it. Once approved, click Support Access again. Access lasts 7 days.
          </DialogDescription>
          <ClipboardField value={created.link} variant="secondary/medium" />
          <DialogFooter className="justify-end">
            <Button variant="primary/small" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const pending = loadFetcher.data?.pending ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>Support Access - {org.title}</DialogHeader>
        <DialogDescription>
          This organization requires approval before Trigger.dev staff can access its dashboard.
        </DialogDescription>
        <submitFetcher.Form method="post" action={endpoint} className="flex flex-col gap-4">
          <Callout variant="warning">
            No active approval. An Owner or Admin of this org has to approve a request first.
            Approval lasts 7 days and covers any Trigger.dev staff member.
          </Callout>
          <div>
            <Label htmlFor="support-access-reason" required>
              Reason
            </Label>
            <TextArea
              id="support-access-reason"
              name="reason"
              rows={4}
              required
              placeholder="e.g. Investigating stuck runs in production"
            />
            <Hint>Shown to the org's admins on their Support Access page.</Hint>
            {error && <FormError>{error}</FormError>}
          </div>
          {pending.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label>Pending requests</Label>
              {pending.map((request) => (
                <div key={request.id} className="rounded-md bg-background-hover px-3 py-2.5">
                  <div className="truncate text-sm text-text-bright">{request.reason}</div>
                  <div className="text-xs text-text-dimmed">
                    {request.requestedBy} · <RelativeDateTime date={new Date(request.createdAt)} />
                  </div>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="tertiary/small" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary/small" disabled={isSubmitting}>
              {isSubmitting ? "Creating..." : "Create request"}
            </Button>
          </DialogFooter>
        </submitFetcher.Form>
      </DialogContent>
    </Dialog>
  );
}
