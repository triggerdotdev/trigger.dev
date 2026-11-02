import {
  ArrowPathIcon,
  DocumentTextIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/20/solid";
import { useRevalidator } from "@remix-run/react";
import type { BillingUsageError } from "@trigger.dev/billing";
import { Button } from "~/components/primitives/Buttons";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { billingUsageErrorState } from "~/utils/billingUsageFormat";

const ICONS = {
  empty: DocumentTextIcon,
  retry: ArrowPathIcon,
  error: ExclamationTriangleIcon,
};

export function BillingUsageErrorPanel({
  error,
  retryable,
}: {
  error: BillingUsageError;
  retryable: boolean;
}) {
  const state = billingUsageErrorState(error);
  const revalidator = useRevalidator();

  return (
    <InfoPanel
      title={state.title}
      icon={ICONS[state.kind]}
      iconClassName={state.kind === "error" ? "text-error" : "text-text-dimmed"}
      panelClassName="max-w-md"
      accessory={
        retryable ? (
          <Button
            variant="tertiary/small"
            disabled={revalidator.state !== "idle"}
            onClick={() => revalidator.revalidate()}
          >
            Try again
          </Button>
        ) : undefined
      }
    >
      {state.message}
    </InfoPanel>
  );
}
