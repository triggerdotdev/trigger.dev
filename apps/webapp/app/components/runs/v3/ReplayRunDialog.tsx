import { Form, useFetcher, useNavigation, useSubmit } from "@remix-run/react";
import { useCallback, useEffect, useRef } from "react";
import { UseDataFunctionReturn, useTypedFetcher } from "remix-typedjson";
import { JSONEditor } from "~/components/code/JSONEditor";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Button } from "~/components/primitives/Buttons";
import { DialogContent, DialogDescription, DialogHeader } from "~/components/primitives/Dialog";
import { Header3 } from "~/components/primitives/Headers";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Select, SelectItem } from "~/components/primitives/Select";
import { ButtonSpinner, Spinner } from "~/components/primitives/Spinner";
import { type loader } from "~/routes/resources.taskruns.$runParam.replay";

type ReplayRunDialogProps = {
  runFriendlyId: string;
  failedRedirect: string;
};

export function ReplayRunDialog({ runFriendlyId, failedRedirect }: ReplayRunDialogProps) {
  const fetcher = useTypedFetcher<typeof loader>();
  const isLoading = fetcher.state !== "idle";

  useEffect(() => {
    fetcher.load(`/resources/taskruns/${runFriendlyId}/replay`);
  }, [runFriendlyId]);

  return (
    <DialogContent key={`replay`}>
      <DialogHeader>Replay this run?</DialogHeader>
      {isLoading ? (
        <div>
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
    </DialogContent>
  );
}

function ReplayForm({
  payload,
  payloadType,
  environment,
  environments,
  failedRedirect,
  runFriendlyId,
}: UseDataFunctionReturn<typeof loader> & { failedRedirect: string; runFriendlyId: string }) {
  const navigation = useNavigation();
  const submit = useSubmit();
  const currentJson = useRef<string>(payload);
  const formAction = `/resources/taskruns/${runFriendlyId}/replay`;
  const isSubmitting = navigation.formAction === formAction;

  const editablePayload = payloadType === "application/json";

  const submitForm = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      const formData = new FormData(e.currentTarget);
      const data: Record<string, string> = {
        environment: formData.get("environment") as string,
        failedRedirect: formData.get("failedRedirect") as string,
      };

      if (editablePayload) {
        data.payload = currentJson.current;
      }

      submit(data, {
        action: formAction,
        method: "post",
      });
      e.preventDefault();
    },
    [currentJson]
  );

  return (
    <Form action={formAction} method="post" onSubmit={(e) => submitForm(e)}>
      {editablePayload ? (
        <>
          <Header3 spacing>Payload</Header3>
          <div className="mb-3 max-h-[70vh] overflow-y-auto rounded-sm border border-grid-dimmed bg-charcoal-900 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            <JSONEditor
              defaultValue={currentJson.current}
              readOnly={false}
              basicSetup
              onChange={(v) => {
                currentJson.current = v;
              }}
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
          text={(value) => {
            const env = environments.find((env) => env.id === value)!;
            return <EnvironmentLabel environment={env} userName={env.userName} />;
          }}
        >
          {(matches) =>
            matches.map((env) => (
              <SelectItem key={env.id} value={env.id}>
                <EnvironmentLabel environment={env} userName={env.userName} />
              </SelectItem>
            ))
          }
        </Select>
      </InputGroup>
      <input type="hidden" name="failedRedirect" value={failedRedirect} />
      <Button
        type="submit"
        variant="primary/small"
        LeadingIcon={isSubmitting ? ButtonSpinner : undefined}
        disabled={isSubmitting}
        shortcut={{ modifiers: ["meta"], key: "enter" }}
        className="mt-3"
      >
        {isSubmitting ? "Replaying..." : "Replay run"}
      </Button>
    </Form>
  );
}
