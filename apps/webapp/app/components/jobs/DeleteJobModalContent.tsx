import { RuntimeEnvironmentType } from "@trigger.dev/database";
import { Header2, Header3 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "../primitives/Table";
import { EnvironmentLabel } from "../environments/EnvironmentLabel";
import { Button } from "../primitives/Buttons";

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

const backgroundTransparent = "group-hover:bg-transparent";

export function DeleteJobDialogContent({ title, slug, lastRun }: DeleteJobDialogContentProps) {
  return (
    <div className="flex flex-col gap-y-4 border-t border-slate-500">
      <Header2>{title}</Header2>
      <Paragraph>ID: {slug}</Paragraph>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Env</TableHeaderCell>
            <TableHeaderCell>Last Run</TableHeaderCell>
            <TableHeaderCell>Version</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell className={backgroundTransparent}>
              <EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />
            </TableCell>
            <TableCell className={backgroundTransparent}>{lastRun}</TableCell>
            <TableCell className={backgroundTransparent}>3</TableCell>
            <TableCell className={backgroundTransparent}>4</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className={backgroundTransparent}>
              <EnvironmentLabel environment={{ type: "PRODUCTION" }} />
            </TableCell>
            <TableCell className={backgroundTransparent}>2</TableCell>
            <TableCell className={backgroundTransparent}>3</TableCell>
            <TableCell className={backgroundTransparent}>4</TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <Header2 className="rounded border border-rose-500 bg-rose-500/10 px-3 py-2 text-center text-bright">
        Are you sure you want to delete this Job?
      </Header2>
      <Paragraph variant="small">
        This will permanently delete the Job "<span className="italic">{title}</span>". This
        includes the deletion of all Run history. This cannot be undone.
      </Paragraph>
      <Button variant={"danger/large"} fullWidth LeadingIcon={"trash-bin"}>
        I want to delete this Job
      </Button>
    </div>
  );
}
