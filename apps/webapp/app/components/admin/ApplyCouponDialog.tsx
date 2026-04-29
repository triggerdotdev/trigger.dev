import { Form, useNavigation } from "@remix-run/react";
import { Button } from "~/components/primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "~/components/primitives/Dialog";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";

export type ApplyCouponTarget = {
  orgId: string;
  orgSlug: string;
  orgTitle: string;
  planCode: string | null;
  subscriptionId: string | null;
  stripeCustomerId: string;
  stripeCustomerEmail: string;
  dealKey: string;
  dealLabel: string;
  dealCategory: string;
};

type ApplyCouponDialogProps = {
  target: ApplyCouponTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ApplyCouponDialog({ target, open, onOpenChange }: ApplyCouponDialogProps) {
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          {target
            ? `Apply ${target.dealLabel} to ${target.orgTitle}?`
            : "Apply coupon deal"}
        </DialogHeader>

        {target && (
          <>
            <Paragraph variant="small" className="text-text-dimmed">
              Re-read the org and Stripe customer below before applying. The
              coupon will be added to the org's active Stripe subscription.
            </Paragraph>

            <Property.Table>
              <Property.Item>
                <Property.Label>Org</Property.Label>
                <Property.Value>
                  {target.orgSlug} · {target.planCode ?? "Free"}
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Stripe customer</Property.Label>
                <Property.Value>
                  {target.stripeCustomerId} ({target.stripeCustomerEmail})
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Stripe sub</Property.Label>
                <Property.Value>{target.subscriptionId ?? "—"}</Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Coupon</Property.Label>
                <Property.Value>
                  {target.dealKey} · {target.dealCategory}
                </Property.Value>
              </Property.Item>
            </Property.Table>

            <Form method="post" className="flex flex-col gap-3" reloadDocument>
              <input type="hidden" name="intent" value="apply" />
              <input type="hidden" name="orgId" value={target.orgId} />
              <input type="hidden" name="dealKey" value={target.dealKey} />

              <DialogFooter>
                <Button
                  type="button"
                  variant="tertiary/medium"
                  onClick={() => onOpenChange(false)}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary/medium"
                  disabled={isSubmitting || !target.subscriptionId}
                >
                  Apply
                </Button>
              </DialogFooter>
            </Form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
