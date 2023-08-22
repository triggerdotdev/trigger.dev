import { JobEnvironment, JobStatusTable } from "~/components/JobsStatusTable";
import { HowToDisableAJob } from "~/components/helpContent/HelpContentText";
import { Button } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { Paragraph } from "~/components/primitives/Paragraph";
import { cn } from "~/utils/cn";

export default function Page({ environments = [] }: { environments: JobEnvironment[] }) {
  return (
    <Help defaultOpen>
      {(open) => (
        <div className={cn("grid h-fit gap-4", open ? "grid-cols-2" : "grid-cols-1")}>
          <div className="w-full">
            <div className="flex items-center justify-between">
              <Header2 className="mb-2 flex items-center gap-1">Delete Job</Header2>
              <HelpTrigger title="How do disable a Job?" />
            </div>
            <JobStatusTable environments={environments} />
            <div className="mt-4 flex w-full items-center justify-end gap-x-3">
              <Paragraph variant="small">
                Disable this Job in all environments before deleting
              </Paragraph>
              <Button
                variant="danger/small"
                leadingIconClassName="text-bright"
                LeadingIcon="trash-can"
              >
                Delete Job
              </Button>
            </div>
          </div>
          <HelpContent title="How to disable a Job">
            <HowToDisableAJob />
          </HelpContent>
        </div>
      )}
    </Help>
  );
}
