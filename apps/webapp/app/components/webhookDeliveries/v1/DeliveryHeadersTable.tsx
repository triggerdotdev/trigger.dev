import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";

/** The request headers stored with a delivery, by name. */
export function DeliveryHeadersTable({ headers }: { headers: Record<string, string> }) {
  const rows = Object.entries(headers).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="flex flex-col">
      <Table showTopBorder={false} stickyHeader>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>Value</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(([name, value]) => (
            <TableRow key={name}>
              <TableCell className="w-1/3">
                <span className="font-mono text-xs text-text-bright">{name}</span>
              </TableCell>
              <TableCell>
                <span className="whitespace-normal break-all font-mono text-xs">
                  {String(value)}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Paragraph variant="extra-small" className="px-3 py-2 text-text-dimmed">
        Authorization and cookie headers, and any header carrying the endpoint's secret, aren't
        stored. Past 4 KB of headers the largest are dropped first, except headers a waiting run
        matches on, which are always kept.
      </Paragraph>
    </div>
  );
}
