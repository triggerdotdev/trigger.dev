import { CheckIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useNavigation, useSubmit } from "@remix-run/react";
import { type TaskRunStatus } from "@trigger.dev/database";
import { useCallback, useEffect, useState } from "react";
import { type UseDataFunctionReturn, useTypedFetcher } from "remix-typedjson";
import { JSONEditor } from "~/components/code/JSONEditor";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { Button } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { Header3 } from "~/components/primitives/Headers";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Spinner, SpinnerWhite } from "~/components/primitives/Spinner";
import { TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";
import { type loader } from "~/routes/resources.taskruns.$runParam.replay";

type ReplayRunDialogProps = {
  runFriendlyId: string;
  failedRedirect: string;
};

type Run = {
  id: string;
  createdAt: Date;
  number: number;
  status: TaskRunStatus;
  payload: string;
};

export function ReplayRunDialog({ runFriendlyId, failedRedirect }: ReplayRunDialogProps) {
  return (
    <DialogContent key="replay" className="md:max-w-xl">
      <ReplayContent runFriendlyId={runFriendlyId} failedRedirect={failedRedirect} />
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

function ReplayForm({
  payload,
  payloadType,
  environment,
  environments,
  runs,
  failedRedirect,
  runFriendlyId,
}: UseDataFunctionReturn<typeof loader> & { failedRedirect: string; runFriendlyId: string }) {
  const navigation = useNavigation();
  const submit = useSubmit();
  const formAction = `/resources/taskruns/${runFriendlyId}/replay`;
  const isSubmitting = navigation.formAction === formAction;

  // State for managing the payload and selection
  const [currentPayload, setCurrentPayload] = useState(payload);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);
  const [isPayloadModified, setIsPayloadModified] = useState(false);
  const [isSelectOpen, setIsSelectOpen] = useState(false);

  const editablePayload =
    payloadType === "application/json" || payloadType === "application/super+json";

  const submitForm = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      const formData = new FormData(e.currentTarget);
      const data: Record<string, string> = {
        environment: formData.get("environment") as string,
        failedRedirect: formData.get("failedRedirect") as string,
      };

      if (editablePayload) {
        data.payload = currentPayload;
      }

      submit(data, {
        action: formAction,
        method: "post",
      });
      e.preventDefault();
    },
    [currentPayload, editablePayload, formAction, submit]
  );

  const selectedRun = runs.find((r) => r.id === selectedRunId);

  const handlePayloadChange = useCallback(
    (newPayload: string) => {
      setCurrentPayload(newPayload);

      // Check if the new payload matches any of the runs
      const matchingRun = runs.find((r) => r.payload === newPayload);
      if (matchingRun) {
        setSelectedRunId(matchingRun.id);
        setIsPayloadModified(false);
      } else {
        setSelectedRunId(undefined);
        setIsPayloadModified(true);
      }
    },
    [runs]
  );

  const handleRunSelect = useCallback(
    (value: string | string[]) => {
      if (Array.isArray(value)) return;

      const run = runs.find((r: Run) => r.id === value);
      if (run) {
        setSelectedRunId(value);
        setCurrentPayload(run.payload);
        setIsPayloadModified(false);
      }
    },
    [runs]
  );

  return (
    <Form action={formAction} method="post" onSubmit={(e) => submitForm(e)} className="pt-2">
      {editablePayload ? (
        <>
          <Paragraph className="mb-3">
            Replaying will create a new run using the same or modified payload, executing against
            the latest version in your selected environment.
          </Paragraph>
          <div className="mb-1 flex items-center justify-between">
            <Header3>Payload</Header3>
            <Select
              key={`${runs.length}-${isSelectOpen}`} // Force re-render when runs change or open state changes
              variant="minimal/small"
              placeholder="Recent payloads"
              text={
                selectedRun && !isPayloadModified
                  ? () => (
                      <span className="whitespace-nowrap tabular-nums">
                        Payload from <DateTime date={selectedRun.createdAt} />
                      </span>
                    )
                  : "Recent payloads"
              }
              items={runs}
              value={selectedRun && !isPayloadModified ? selectedRunId : ""}
              defaultValue=""
              setValue={handleRunSelect}
              open={isSelectOpen}
              setOpen={setIsSelectOpen}
              dropdownIcon
            >
              {(items: Run[]) =>
                items.length === 0 ? (
                  <SelectItem value="" disabled>
                    No recent payloads available
                  </SelectItem>
                ) : (
                  items.map((run) => (
                    <SelectItem key={run.id} value={run.id} checkIcon={null}>
                      <div className="flex w-full items-center justify-between gap-2">
                        <div className="flex w-full items-center justify-between gap-2 tabular-nums">
                          <div className="flex items-center gap-2">
                            <Paragraph variant="small">Run {run.number}</Paragraph>
                            <Paragraph variant="small/bright">
                              <DateTime date={run.createdAt} />
                            </Paragraph>
                          </div>
                          <div className="flex items-center gap-1 text-xs text-text-dimmed">
                            <TaskRunStatusCombo status={run.status} />
                          </div>
                        </div>
                        {selectedRun?.id === run.id && !isPayloadModified && (
                          <CheckIcon className="size-4 flex-none text-success" />
                        )}
                        {!(selectedRun?.id === run.id && !isPayloadModified) && (
                          <div className="size-4 flex-none" />
                        )}
                      </div>
                    </SelectItem>
                  ))
                )
              }
            </Select>
          </div>
          <div className="mb-3 max-h-[70vh] min-h-40 overflow-y-auto rounded-sm border border-grid-dimmed bg-charcoal-900 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            <JSONEditor
              autoFocus
              defaultValue={currentPayload}
              readOnly={false}
              basicSetup
              onChange={handlePayloadChange}
              showClearButton={false}
              showCopyButton={false}
              height="100%"
              min-height="100%"
              max-height="100%"
            />
          </div>
        </>
      ) : null}
      <InputGroup>
        <Label>Environment</Label>
        <Select
          id="environment"
          name="environment"
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
                <EnvironmentCombo environment={env} />
              </div>
            );
          }}
        >
          {(matches) =>
            matches.map((env) => (
              <SelectItem key={env.id} value={env.id}>
                <EnvironmentCombo environment={env} />
              </SelectItem>
            ))
          }
        </Select>
      </InputGroup>
      <input type="hidden" name="failedRedirect" value={failedRedirect} />
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-grid-dimmed pt-3.5">
        <DialogClose asChild>
          <Button variant="tertiary/medium">Cancel</Button>
        </DialogClose>
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
    </Form>
  );
}
