import { ChevronRightIcon } from "@heroicons/react/20/solid";
import type { BillingUsageCredit } from "@trigger.dev/billing";
import { useState } from "react";
import { TableCell, TableRow } from "~/components/primitives/Table";
import { billingDisplayName, creditSourceLabel } from "~/utils/billingUsageFormat";
import { formatCreditPeriod } from "~/utils/billingUsagePeriod";
import { cn } from "~/utils/cn";
import { UsagePlaceholder } from "./UsagePlaceholder";

/**
 * The credit Metronome applied to usage this month, next to the credit available for it. One line that opens
 * into each credit when there's more than one. A credit only pays usage that ran while its contract was
 * active, so what's available can be more than what applied.
 */
export function UsageCreditsRows({
  available,
  applied,
  credits,
  money,
  columns,
  isLoading = false,
}: {
  available: number;
  applied: number;
  credits: BillingUsageCredit[];
  money: (amount: number) => string;
  columns: number;
  isLoading?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const canExpand = credits.length > 1;
  const only = credits.length === 1 ? credits[0] : undefined;

  return (
    <>
      <TableRow>
        <TableCell className="text-text-dimmed">
          <div className="flex items-center gap-1">
            {canExpand && (
              <button
                type="button"
                aria-expanded={isOpen}
                aria-label={isOpen ? "Hide credits" : "Show credits"}
                onClick={() => setIsOpen((open) => !open)}
                className="flex size-5 items-center justify-center rounded-sm hover:bg-background-hover hover:text-text-bright"
              >
                <ChevronRightIcon className={cn("size-4 transition", isOpen && "rotate-90")} />
              </button>
            )}
            <span>Included usage credit</span>
            {canExpand && <span className="ml-1 text-xs tabular-nums">{credits.length}</span>}
            {only && <CreditDetail credit={only} />}
          </div>
        </TableCell>
        {Array.from({ length: columns }, (_, index) => (
          <TableCell key={index} alignment="right" className="tabular-nums">
            {index === 0 && !isLoading && (
              <CreditUse available={available} applied={applied} money={money} />
            )}
            {index === columns - 2 && (isLoading ? <UsagePlaceholder /> : `−${money(applied)}`)}
          </TableCell>
        ))}
      </TableRow>
      {isOpen &&
        credits.map((credit) => (
          <TableRow key={credit.id}>
            <TableCell>
              <div className="flex flex-col pl-6">
                <span className="text-text-bright">{billingDisplayName(credit.name)}</span>
                <CreditDetail credit={credit} />
              </div>
            </TableCell>
            {Array.from({ length: columns }, (_, index) => (
              <TableCell key={index} alignment="right" className="tabular-nums">
                {index === 0 &&
                  (forUsage(credit) === 0 ? (
                    <span className="text-text-dimmed">Pays fees and add-ons</span>
                  ) : (
                    <CreditUse available={credit.amount} applied={credit.applied} money={money} />
                  ))}
                {index === columns - 2 &&
                  (isLoading ? (
                    <UsagePlaceholder />
                  ) : credit.applied > 0 ? (
                    `−${money(credit.applied)}`
                  ) : (
                    "–"
                  ))}
              </TableCell>
            ))}
          </TableRow>
        ))}
    </>
  );
}

function forUsage(credit: BillingUsageCredit): number {
  return credit.forUsage ?? credit.applied;
}

function CreditUse({
  available,
  applied,
  money,
}: {
  available: number;
  applied: number;
  money: (amount: number) => string;
}) {
  return (
    <span className="whitespace-nowrap text-text-dimmed">
      {money(available)} available · {money(applied)} applied to usage
    </span>
  );
}

function CreditDetail({ credit }: { credit: BillingUsageCredit }) {
  return (
    <span className="text-xs text-text-dimmed">
      {[creditSourceLabel(credit), formatCreditPeriod(credit.startsAt, credit.endsAt)].join(" · ")}
    </span>
  );
}
