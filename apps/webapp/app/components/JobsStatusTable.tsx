import { RuntimeEnvironmentType } from "@trigger.dev/database";
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
};

type JobStatusTableProps = {
  environments: JobEnvironment[];
};

export function JobStatusTable({ environments }: JobStatusTableProps) {
  return (
    <Table fullWidth>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Env</TableHeaderCell>
          <TableHeaderCell>Last Run</TableHeaderCell>
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
