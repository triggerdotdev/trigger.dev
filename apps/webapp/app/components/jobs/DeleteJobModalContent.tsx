import { RuntimeEnvironmentType } from "@trigger.dev/database";
import { EnvironmentLabel } from "../environments/EnvironmentLabel";
import { Button } from "../primitives/Buttons";
import { Header1, Header2 } from "../primitives/Headers";
import { NamedIcon } from "../primitives/NamedIcon";
import { Paragraph } from "../primitives/Paragraph";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "../primitives/Table";
import { cn } from "~/utils/cn";
import { TextLink } from "../primitives/TextLink";
import { DateTime } from "../primitives/DateTime";
import { ActiveBadge } from "../ActiveBadge";

type JobEnvironment = {
  type: RuntimeEnvironmentType;
  lastRun?: Date;
  version: string;
  enabled: boolean;
};

type DeleteJobDialogContentProps = {
  title: string;
  slug: string;
  environments: JobEnvironment[];
};

export function DeleteJobDialogContent({ title, slug, environments }: DeleteJobDialogContentProps) {
  const canDelete = environments.every((environment) => environment.enabled === false);

  return (
    <div className="flex w-full flex-col items-center gap-y-6">
      <div className="flex flex-col items-center justify-center gap-y-2">
        <Header1>{title}</Header1>
        <Paragraph variant="small">ID: {slug}</Paragraph>
      </div>
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
          {environments.map((environment) => (
            <TableRow>
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

      <Header2
        className={cn(
          canDelete ? "border-rose-500 bg-rose-500/10" : "border-amber-500 bg-amber-500/10",
          "rounded border px-3.5 py-2 text-center text-bright"
        )}
      >
        {canDelete
          ? "Are you sure you want to delete this Job?"
          : "You can't delete this Job until all env are disabled"}
      </Header2>
      <Paragraph variant="small" className="px-6 text-center">
        {canDelete ? (
          <>
            This will permanently delete the Job <span className="strong text-bright">{title}</span>
            . This includes the deletion of all Run history. This cannot be undone.
          </>
        ) : (
          <>
            This Job is still active in an environment. You need to disable it in your Job code
            first before it can be deleted. <TextLink to="#">Learn how to disable a Job</TextLink>.
          </>
        )}
      </Paragraph>

      <Button variant="danger/large" fullWidth disabled={!canDelete}>
        <NamedIcon
          name={"trash-can"}
          className={"mr-1.5 h-4 w-4 text-bright transition group-hover:text-bright"}
        />
        I want to delete this Job
      </Button>
    </div>
  );
}
