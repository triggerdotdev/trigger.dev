import { RuntimeEnvironmentType } from "@trigger.dev/database";
import { cn } from "~/utils/cn";
import { JobStatusTable } from "../JobsStatusTable";
import { Button } from "../primitives/Buttons";
import { Header1, Header2 } from "../primitives/Headers";
import { NamedIcon } from "../primitives/NamedIcon";
import { Paragraph } from "../primitives/Paragraph";
import { TextLink } from "../primitives/TextLink";
import { useFetcher } from "@remix-run/react";
import { Spinner } from "../primitives/Spinner";

type JobEnvironment = {
  type: RuntimeEnvironmentType;
  lastRun?: Date;
  version: string;
  enabled: boolean;
};

type DeleteJobDialogContentProps = {
  id: string;
  title: string;
  slug: string;
  environments: JobEnvironment[];
  redirectTo?: string;
};

export function DeleteJobDialogContent({
  title,
  slug,
  environments,
  id,
  redirectTo,
}: DeleteJobDialogContentProps) {
  const canDelete = environments.every((environment) => !environment.enabled);
  const fetcher = useFetcher();

  const isLoading =
    fetcher.state === "submitting" ||
    (fetcher.state === "loading" && fetcher.formMethod === "DELETE");

  return (
    <div className="flex w-full flex-col items-center gap-y-6">
      <div className="flex flex-col items-center justify-center gap-y-2">
        <Header1>{title}</Header1>
        <Paragraph variant="small">ID: {slug}</Paragraph>
      </div>
      <JobStatusTable environments={environments} />

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
            first before it can be deleted.{" "}
            <TextLink to="https://trigger.dev/docs/documentation/guides/jobs/managing#disabling-jobs">
              Learn how to disable a Job
            </TextLink>
            .
          </>
        )}
      </Paragraph>
      {canDelete ? (
        <fetcher.Form
          method="delete"
          action={`/resources/jobs/${id}${redirectTo ? `?redirectTo=${redirectTo}` : ""}`}
        >
          <Button variant="danger/large" fullWidth>
            {isLoading ? (
              <Spinner />
            ) : (
              <>
                <NamedIcon
                  name="trash-can"
                  className="mr-1.5 h-4 w-4 text-bright transition group-hover:text-bright"
                />
                Delete this job
              </>
            )}
          </Button>
        </fetcher.Form>
      ) : (
        <Button variant="danger/large" fullWidth disabled>
          <>
            <NamedIcon
              name="trash-can"
              className="mr-1.5 h-4 w-4 text-bright transition group-hover:text-bright"
            />
            Delete this job
          </>
        </Button>
      )}
    </div>
  );
}
