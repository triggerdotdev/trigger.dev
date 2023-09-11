import { JobEnvironment, JobStatusTable } from "~/components/JobsStatusTable";
import { HowToDisableAJob } from "~/components/helpContent/HelpContentText";
import { DeleteJobDialogContent } from "~/components/jobs/DeleteJobModalContent";
import { Button } from "~/components/primitives/Buttons";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Header2 } from "~/components/primitives/Headers";
import { Help, HelpContent, HelpTrigger } from "~/components/primitives/Help";
import { Paragraph } from "~/components/primitives/Paragraph";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import { projectJobsPath, projectPath } from "~/utils/pathBuilder";

export default function Page() {
  const job = useJob();
  const organization = useOrganization();
  const project = useProject();

  return (
    <Help defaultOpen>
      {(open) => (
        <div className={cn("grid h-fit gap-4", open ? "grid-cols-2" : "grid-cols-1")}>
          <div className="w-full">
            <div className="flex items-center justify-between">
              <Header2 className="mb-2 flex items-center gap-1">Environments</Header2>
              <HelpTrigger title="How do disable a Job?" />
            </div>
            <JobStatusTable environments={job.environments} />
            <div className="mt-4 flex w-full items-center justify-end gap-x-3">
              {job.status === "ACTIVE" && (
                <Paragraph variant="small">
                  Disable this Job in all environments before deleting
                </Paragraph>
              )}

              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    variant="danger/small"
                    leadingIconClassName="text-bright"
                    LeadingIcon="trash-can"
                  >
                    I want to delete this Job
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DeleteJobDialogContent
                      title={job.title}
                      slug={job.slug}
                      environments={job.environments}
                      id={job.id}
                      redirectTo={projectJobsPath(organization, project)}
                    />
                  </DialogHeader>
                </DialogContent>
              </Dialog>
            </div>
          </div>
          <HelpContent title="How to disable a Job">
            <HowToDisableAJob id={job.slug} version={job.version} name={job.title} />
          </HelpContent>
        </div>
      )}
    </Help>
  );
}
