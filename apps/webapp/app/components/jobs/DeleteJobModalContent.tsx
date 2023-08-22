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

type JobEnvironment = {
  type: RuntimeEnvironmentType;
  lastRun?: Date;
  version: string;
  enabled: boolean;
};

type DeleteJobDialogContentProps = JobEnvironment & {
  title: string;
  slug: string;
  environments: JobEnvironment[];
};

const backgroundTransparent = "group-hover:bg-transparent";

export function DeleteJobDialogContent({
  title,
  slug,
  lastRun,
  version,
  enabled,
}: DeleteJobDialogContentProps) {
  return (
    <div className="mt-4 flex w-full flex-col items-center gap-y-6 border-t border-slate-850">
      <div className="flex flex-col items-center justify-center gap-y-2">
        <Header1 className="mt-4">{title}</Header1>
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
          <TableRow>
            <TableCell className={backgroundTransparent}>
              <EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />
            </TableCell>
            <TableCell className={backgroundTransparent}>
              {lastRun ? lastRun.toDateString() : "Never Run"}
            </TableCell>
            <TableCell alignment="right" className={backgroundTransparent}>
              {version}
            </TableCell>
            <TableCell alignment="right" className={backgroundTransparent}>
              {enabled}
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell className={backgroundTransparent}>
              <EnvironmentLabel environment={{ type: "PRODUCTION" }} />
            </TableCell>
            <TableCell className={backgroundTransparent}>
              {lastRun ? lastRun.toDateString() : "Never Run"}
            </TableCell>
            <TableCell alignment="right" className={backgroundTransparent}>
              {version}
            </TableCell>
            <TableCell alignment="right" className={backgroundTransparent}>
              {enabled}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <Header2
        className={cn(
          enabled === true ? "border-amber-500 bg-amber-500/10" : "border-rose-500 bg-rose-500/10",
          "rounded border px-3.5 py-2 text-center text-bright"
        )}
      >
        {enabled === true
          ? "You can't delete this Job yet."
          : "Are you sure you want to delete this Job?"}
      </Header2>
      <Paragraph variant="small" className="px-6 text-center">
        {enabled === true ? (
          <>
            This Job is still active in your dev environment. You need to disable it in your Job
            code first before it can be deleted.{" "}
            <TextLink to="#">Learn how to disable a Job</TextLink>.
          </>
        ) : (
          <>
            This will permanently delete the Job
            <span className="strong text-bright">{title}</span>. This includes the deletion of all
            Run history. This cannot be undone.
          </>
        )}
      </Paragraph>

      <Button variant="danger/large" fullWidth disabled={enabled}>
        <NamedIcon
          name={"trash-can"}
          className={"mr-1.5 h-4 w-4 text-bright transition group-hover:text-bright"}
        />
        I want to delete this Job
      </Button>
    </div>
  );
}
