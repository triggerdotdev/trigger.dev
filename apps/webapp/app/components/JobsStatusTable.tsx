import { type RuntimeEnvironmentType } from "@trigger.dev/database";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { EnvironmentLabel } from "./environments/EnvironmentLabel";
import { DateTime } from "./primitives/DateTime";
import { ActiveBadge } from "./ActiveBadge";

export type JobEnvironment = {
  type: RuntimeEnvironmentType;
  lastRun?: Date;
  version: string;
  enabled: boolean;
  concurrencyLimit?: number | null;
  concurrencyLimitGroup?: { name: string; concurrencyLimit: number } | null;
};

type JobStatusTableProps = {
  environments: JobEnvironment[];
  displayStyle?: "short" | "long";
};

export function JobStatusTable({ environments, displayStyle = "short" }: JobStatusTableProps) {
  return (
    <Table fullWidth>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Env</TableHeaderCell>
          <TableHeaderCell>Last Run</TableHeaderCell>
          {displayStyle === "long" && <TableHeaderCell>Concurrency</TableHeaderCell>}
          <TableHeaderCell alignment="right">Version</TableHeaderCell>
          <TableHeaderCell alignment="right">Status</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {environments.map((environment, index) => (
          <TableRow key={index}>
            <TableCell>
              <EnvironmentLabel environment={environment} />
            </TableCell>
            <TableCell>
              {environment.lastRun ? <DateTime date={environment.lastRun} /> : "Never Run"}
            </TableCell>
            {displayStyle === "long" && (
              <TableCell>
                {environment.concurrencyLimitGroup ? (
                  <span className="flex items-center gap-1">
                    <span>{environment.concurrencyLimitGroup.name}</span>
                    <span className="text-gray-400">
                      ({environment.concurrencyLimitGroup.concurrencyLimit})
                    </span>
                  </span>
                ) : typeof environment.concurrencyLimit === "number" ? (
                  <span className="text-gray-400">{environment.concurrencyLimit}</span>
                ) : (
                  <span className="text-gray-400">Not specified</span>
                )}
              </TableCell>
            )}

            <TableCell alignment="right">{environment.version}</TableCell>
            <TableCell alignment="right">
              <ActiveBadge active={environment.enabled} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
