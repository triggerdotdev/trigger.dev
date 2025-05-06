import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useNavigation, useSubmit } from "@remix-run/react";
import { useCallback, useEffect, useState } from "react";
import { type UseDataFunctionReturn, useTypedFetcher } from "remix-typedjson";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { Button } from "~/components/primitives/Buttons";
import { DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { Header3 } from "~/components/primitives/Headers";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Spinner, SpinnerWhite } from "~/components/primitives/Spinner";
import { type ScheduledRun, type StandardRun } from "~/presenters/v3/TestTaskPresenter.server";
import {
  ScheduledTaskForm,
  StandardTaskForm,
} from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.test.tasks.$taskParam/route";
import { type loader } from "~/routes/resources.taskruns.$runParam.replay";
import type { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import { Callout } from "~/components/primitives/Callout";

type ReplayRunDialogProps = {
  runFriendlyId: string;
  failedRedirect: string;
};

export function ReplayRunDialog({ runFriendlyId, failedRedirect }: ReplayRunDialogProps) {
  return (
    <DialogContent key="replay" className="grid h-full pr-0 md:max-h-[90vh] md:max-w-7xl">
      <div className="flex h-full min-h-0 flex-col">
        <ReplayContent runFriendlyId={runFriendlyId} failedRedirect={failedRedirect} />
      </div>
    </DialogContent>
  );
}

function ReplayContent({ runFriendlyId, failedRedirect }: ReplayRunDialogProps) {
  const fetcher = useTypedFetcher<typeof loader>();
  const isLoading = fetcher.state === "loading";

  useEffect(() => {
    fetcher.load(`/resources/taskruns/${runFriendlyId}/replay`);
  }, [runFriendlyId]);

  return (
    <>
      <DialogHeader>Replay this run</DialogHeader>
      {isLoading ? (
        <div className="grid place-items-center p-6">
          <Spinner />
        </div>
      ) : fetcher.data ? (
        <ReplayForm
          {...fetcher.data}
          failedRedirect={failedRedirect}
          runFriendlyId={runFriendlyId}
        />
      ) : (
        <>Failed to get run data</>
      )}
    </>
  );
}

function ReplayForm(
  props: UseDataFunctionReturn<typeof loader> & { failedRedirect: string; runFriendlyId: string }
) {
  const navigation = useNavigation();
  const formAction = `/resources/taskruns/${props.runFriendlyId}/replay`;
  const isSubmitting = navigation.formAction === formAction;

  const possibleTimezones = "possibleTimezones" in props ? props.possibleTimezones : [];

  return (
    <>
      <Paragraph variant="small" className="mt-3 py-3.5">
        Replaying will create a new run using the same or modified payload, executing against the
        latest version in your selected environment.
      </Paragraph>
      <div className="flex-1">
        {props.taskType === "STANDARD" ? (
          <StandardTaskForm
            task={props.task}
            runs={props.runs as StandardRun[]}
            formAction={formAction}
            footer={
              <ReplayFormFooter
                environment={props.environment}
                environments={props.environments}
                isSubmitting={isSubmitting}
              />
            }
            className="rounded-l-lg border-y border-l border-grid-dimmed"
          />
        ) : props.taskType === "SCHEDULED" ? (
          <ScheduledTaskForm
            task={props.task}
            runs={props.runs as ScheduledRun[]}
            possibleTimezones={possibleTimezones}
            formAction={formAction}
            footer={
              <ReplayFormFooter
                environment={props.environment}
                environments={props.environments}
                isSubmitting={isSubmitting}
              />
            }
            className="rounded-l-lg border-y border-l border-grid-dimmed"
          />
        ) : null}
      </div>
    </>
  );
}

type DisplayableEnvironment = {
  id: string;
  type: string;
  slug: string;
  userName?: string;
};

function ReplayFormFooter({
  environment,
  environments,
  isSubmitting,
}: {
  environment: DisplayableEnvironment;
  environments: DisplayableEnvironment[];
  isSubmitting: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 pr-3 pt-3.5">
      <DialogClose asChild>
        <Button variant="tertiary/medium">Cancel</Button>
      </DialogClose>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2">
          <Label>Replay this run in:</Label>
          <Select
            id="environment"
            name="environmentId"
            placeholder="Select an environment"
            defaultValue={environment.id}
            items={environments}
            dropdownIcon
            variant="tertiary/medium"
            className="w-fit pl-1"
            text={(value) => {
              const env = environments.find((env) => env.id === value)!;
              return (
                <div className="flex items-center pl-1 pr-2">
                  <EnvironmentCombo environment={env as RuntimeEnvironment} />
                </div>
              );
            }}
          >
            {(matches) =>
              matches.map((env) => (
                <SelectItem key={env.id} value={env.id}>
                  <EnvironmentCombo environment={env as RuntimeEnvironment} />
                </SelectItem>
              ))
            }
          </Select>
        </div>
        <Button
          type="submit"
          variant="primary/medium"
          LeadingIcon={isSubmitting ? SpinnerWhite : undefined}
          disabled={isSubmitting}
          shortcut={{ modifiers: ["mod"], key: "enter", enabledOnInputElements: true }}
        >
          {isSubmitting ? "Replaying..." : "Replay run"}
        </Button>
      </div>
    </div>
  );
}
