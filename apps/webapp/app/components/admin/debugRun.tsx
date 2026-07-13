import { useIsImpersonating } from "~/hooks/useOrganizations";
import { useHasAdminAccess } from "~/hooks/useUser";
import { Button } from "../primitives/Buttons";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "../primitives/Dialog";
import { Cog6ToothIcon } from "@heroicons/react/20/solid";
import { type loader } from "~/routes/resources.taskruns.$runParam.debug";
import type { UseDataFunctionReturn } from "remix-typedjson";
import { useTypedFetcher } from "remix-typedjson";
import { useEffect } from "react";
import { Spinner } from "../primitives/Spinner";
import * as Property from "~/components/primitives/PropertyTable";
import { ClipboardField } from "../primitives/ClipboardField";

export function AdminDebugRun({ friendlyId }: { friendlyId: string }) {
  const hasAdminAccess = useHasAdminAccess();
  const isImpersonating = useIsImpersonating();

  if (!hasAdminAccess && !isImpersonating) {
    return null;
  }

  return (
    <Dialog key={`debug-${friendlyId}`}>
      <DialogTrigger asChild>
        <Button variant="tertiary/small" LeadingIcon={Cog6ToothIcon}>
          Debug run
        </Button>
      </DialogTrigger>
      <DebugRunDialog friendlyId={friendlyId} />
    </Dialog>
  );
}

export function DebugRunDialog({ friendlyId }: { friendlyId: string }) {
  return (
    <DialogContent
      key={`debug`}
      className="overflow-y-auto sm:h-[80vh] sm:max-h-[80vh] sm:max-w-[50vw]"
    >
      <DebugRunContent friendlyId={friendlyId} />
    </DialogContent>
  );
}

function DebugRunContent({ friendlyId }: { friendlyId: string }) {
  const fetcher = useTypedFetcher<typeof loader>();
  const isLoading = fetcher.state === "loading";

  useEffect(() => {
    fetcher.load(`/resources/taskruns/${friendlyId}/debug`);
  }, [friendlyId]);

  return (
    <>
      <DialogHeader>Debugging run</DialogHeader>
      {isLoading ? (
        <div className="grid place-items-center p-6">
          <Spinner />
        </div>
      ) : fetcher.data ? (
        <DebugRunData {...fetcher.data} />
      ) : (
        <>Failed to get run debug data</>
      )}
    </>
  );
}

function DebugRunData(props: UseDataFunctionReturn<typeof loader>) {
  if (props.engine === "V1") {
    return <DebugRunDataEngineV1 run={props.run} />;
  }

  return <DebugRunDataEngineV2 {...props} />;
}

function DebugRunDataEngineV1({ run }: { run: UseDataFunctionReturn<typeof loader>["run"] }) {
  return (
    <Property.Table>
      <Property.Item>
        <Property.Label>ID</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField value={run.id} variant="tertiary/small" iconButton />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Engine</Property.Label>
        <Property.Value>
          Engine V1 (v3) is retired. Queue debug data is no longer available for V1 runs.
        </Property.Value>
      </Property.Item>
    </Property.Table>
  );
}

function DebugRunDataEngineV2({
  run,
  queueConcurrencyLimit,
  queueCurrentConcurrency,
  envConcurrencyLimit,
  envCurrentConcurrency,
  keys,
}: Extract<UseDataFunctionReturn<typeof loader>, { engine: "V2" }>) {
  return (
    <Property.Table>
      <Property.Item>
        <Property.Label>ID</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField value={run.id} variant="tertiary/small" iconButton />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Queue current concurrency</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <span>{queueCurrentConcurrency ?? "0"}</span>
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Queue concurrency limit</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <span>{queueConcurrencyLimit ?? "Not set"}</span>
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Env current concurrency</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <span>{envCurrentConcurrency ?? "0"}</span>
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Env concurrency limit</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <span>{envConcurrencyLimit ?? "Not set"}</span>
        </Property.Value>
      </Property.Item>
      {keys.map((key) => (
        <Property.Item key={key.key}>
          <Property.Label>{key.label}</Property.Label>
          <Property.Value className="flex items-center gap-2">
            <ClipboardField value={key.key} variant="tertiary/small" iconButton />
          </Property.Value>
        </Property.Item>
      ))}
    </Property.Table>
  );
}
