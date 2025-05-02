import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useNavigation, useSubmit } from "@remix-run/react";
import { useCallback, useEffect, useState } from "react";
import { type UseDataFunctionReturn, useTypedFetcher } from "remix-typedjson";
import { JSONEditor } from "~/components/code/JSONEditor";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { Button } from "~/components/primitives/Buttons";
import { DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { Header3 } from "~/components/primitives/Headers";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import { Spinner, SpinnerWhite } from "~/components/primitives/Spinner";
import { RecentPayloads } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.test.tasks.$taskParam/route";
import { type loader } from "~/routes/resources.taskruns.$runParam.replay";

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

  return (
    <Form
      action={formAction}
      method="post"
      onSubmit={(e) => submitForm(e)}
      className="flex h-full flex-col overflow-hidden pt-2"
    >
      {editablePayload ? (
        <>
          <Paragraph className="py-3">
            Replaying will create a new run using the same or modified payload, executing against
            the latest version in your selected environment.
          </Paragraph>
          <div className="grid h-0 flex-1 grid-cols-[1fr_auto] gap-0 divide-x divide-grid-dimmed border-t border-grid-dimmed">
            <div className="flex h-full min-h-0 flex-col">
              <Header3>Payload</Header3>
              <div className="min-h-0 flex-1 overflow-y-auto rounded-sm border-l border-grid-dimmed bg-charcoal-900 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
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
            </div>
            <RecentPayloads
              runs={runs}
              selectedId={selectedRunId}
              onSelected={(id) => {
                const run = runs.find((r) => r.id === id);
                if (run) {
                  setSelectedRunId(id);
                  setCurrentPayload(run.payload);
                  setIsPayloadModified(false);
                }
              }}
            />
          </div>
        </>
      ) : null}
      <input type="hidden" name="failedRedirect" value={failedRedirect} />
      <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed pr-3 pt-3.5">
        <DialogClose asChild>
          <Button variant="tertiary/medium">Cancel</Button>
        </DialogClose>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <Label>Replay this run in:</Label>
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
    </Form>
  );
}
