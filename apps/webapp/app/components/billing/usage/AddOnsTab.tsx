import type { BillingAddOns } from "@trigger.dev/billing";
import { MetricsLayout } from "~/components/layout/MetricsLayout";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import {
  billingDisplayName,
  formatAddOnQuantity,
  formatUsageDollars,
  USD_CENTS_CREDIT_TYPE,
} from "~/utils/billingUsageFormat";
import { formatUsageDay } from "~/utils/billingUsagePeriod";
import { UsageFooterRow } from "./UsageBreakdownTable";

export function AddOnsTab({ addOns }: { addOns: BillingAddOns }) {
  const minorUnits = (addOns.creditType ?? USD_CENTS_CREDIT_TYPE).currency?.minorUnitsPerUnit ?? 1;
  const money = (amount: number) => formatUsageDollars(amount / minorUnits);
  const nextTotal = addOns.next.reduce((sum, line) => sum + line.total, 0);

  return (
    <>
      <MetricsLayout.Content
        toolbar={
          <Header2 className="pl-1.5">
            Add-ons on the {formatUsageDay(addOns.invoiceDate)} invoice
          </Header2>
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Add-on</TableHeaderCell>
              <TableHeaderCell alignment="right">Quantity</TableHeaderCell>
              <TableHeaderCell alignment="right">Unit price</TableHeaderCell>
              <TableHeaderCell alignment="right">Amount</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {addOns.next.length === 0 ? (
              <TableBlankRow colSpan={4}>
                <Paragraph className="w-auto" variant="base/bright">
                  No add-ons on the next invoice
                </Paragraph>
              </TableBlankRow>
            ) : (
              addOns.next.map((line) => (
                <TableRow key={line.productId}>
                  <TableCell>{line.name}</TableCell>
                  <TableCell alignment="right" className="tabular-nums">
                    {formatAddOnQuantity(line.name, line.quantity)}
                  </TableCell>
                  <TableCell alignment="right" className="tabular-nums text-text-dimmed">
                    {line.unitPrice === null ? "–" : money(line.unitPrice)}
                  </TableCell>
                  <TableCell alignment="right" className="tabular-nums">
                    {money(line.total)}
                  </TableCell>
                </TableRow>
              ))
            )}
            {addOns.next.length > 0 && (
              <UsageFooterRow label="Total" cells={[null, null, money(nextTotal)]} emphasis />
            )}
          </TableBody>
        </Table>
      </MetricsLayout.Content>
      {addOns.charged.length > 0 && (
        <MetricsLayout.Content
          toolbar={<Header2 className="pl-1.5">Charged this month, prorated</Header2>}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Charge or credit</TableHeaderCell>
                <TableHeaderCell>Date</TableHeaderCell>
                <TableHeaderCell alignment="right">Amount</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {addOns.charged.map((charge) => (
                <TableRow key={`${charge.date}|${charge.name}`}>
                  <TableCell className="text-text-dimmed">
                    {billingDisplayName(charge.name)}
                  </TableCell>
                  <TableCell className="text-text-dimmed">{formatUsageDay(charge.date)}</TableCell>
                  <TableCell alignment="right" className="tabular-nums text-text-dimmed">
                    {charge.total < 0 ? `−${money(-charge.total)}` : money(charge.total)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </MetricsLayout.Content>
      )}
    </>
  );
}
