import { useIsImpersonating } from "~/hooks/useOrganizations";
import { useHasAdminAccess } from "~/hooks/useUser";
import { Button } from "../primitives/Buttons";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "../primitives/Dialog";
import { Cog6ToothIcon } from "@heroicons/react/20/solid";
import { type loader } from "~/routes/resources.taskruns.$runParam.debug";
import { UseDataFunctionReturn, useTypedFetcher } from "remix-typedjson";
import { useEffect } from "react";
import { Spinner } from "../primitives/Spinner";
import * as Property from "~/components/primitives/PropertyTable";
import { ClipboardField } from "../primitives/ClipboardField";
import { MarQSShortKeyProducer } from "~/v3/marqs/marqsKeyProducer";

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
    return <DebugRunDataEngineV1 {...props} />;
  }

  return <DebugRunDataEngineV2 {...props} />;
}

function DebugRunDataEngineV1({
  run,
  queueConcurrencyLimit,
  queueCurrentConcurrency,
  envConcurrencyLimit,
  envCurrentConcurrency,
  queueReserveConcurrency,
  envReserveConcurrency,
}: UseDataFunctionReturn<typeof loader>) {
  const keys = new MarQSShortKeyProducer("marqs:");

  const withPrefix = (key: string) => `marqs:${key}`;

  return (
    <Property.Table>
      <Property.Item>
        <Property.Label>ID</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField value={run.id} variant="tertiary/small" iconButton />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Message key</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={withPrefix(keys.messageKey(run.id))}
            variant="tertiary/small"
            iconButton
          />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>GET message</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={`GET ${withPrefix(keys.messageKey(run.id))}`}
            variant="tertiary/small"
            iconButton
          />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Queue key</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={withPrefix(
              keys.queueKey(run.runtimeEnvironment, run.queue, run.concurrencyKey ?? undefined)
            )}
            variant="tertiary/small"
            iconButton
          />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Get queue set</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={`ZRANGE ${withPrefix(
              keys.queueKey(run.runtimeEnvironment, run.queue, run.concurrencyKey ?? undefined)
            )} 0 -1`}
            variant="tertiary/small"
            iconButton
          />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Queue current concurrency key</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={withPrefix(
              keys.queueCurrentConcurrencyKey(
                run.runtimeEnvironment,
                run.queue,
                run.concurrencyKey ?? undefined
              )
            )}
            variant="tertiary/small"
            iconButton
          />
        </Property.Value>
      </Property.Item>

      <Property.Item>
        <Property.Label>Get queue current concurrency</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={`SMEMBERS ${withPrefix(
              keys.queueCurrentConcurrencyKey(
                run.runtimeEnvironment,
                run.queue,
                run.concurrencyKey ?? undefined
              )
            )}`}
            variant="tertiary/small"
            iconButton
          />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Queue current concurrency</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <span>{queueCurrentConcurrency ?? "0"}</span>
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Queue reserve concurrency key</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={withPrefix(
              keys.queueReserveConcurrencyKeyFromQueue(
                keys.queueKey(run.runtimeEnvironment, run.queue, run.concurrencyKey ?? undefined)
              )
            )}
            variant="tertiary/small"
            iconButton
          />
        </Property.Value>
      </Property.Item>

      <Property.Item>
        <Property.Label>Get queue reserve concurrency</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={`SMEMBERS ${withPrefix(
              keys.queueReserveConcurrencyKeyFromQueue(
                keys.queueKey(run.runtimeEnvironment, run.queue, run.concurrencyKey ?? undefined)
              )
            )}`}
            variant="tertiary/small"
            iconButton
          />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Queue reserve concurrency</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <span>{queueReserveConcurrency ?? "0"}</span>
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Queue concurrency limit key</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={withPrefix(keys.queueConcurrencyLimitKey(run.runtimeEnvironment, run.queue))}
            variant="tertiary/small"
            iconButton
          />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>GET queue concurrency limit</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={`GET ${withPrefix(
              keys.queueConcurrencyLimitKey(run.runtimeEnvironment, run.queue)
            )}`}
            variant="tertiary/small"
            iconButton
          />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Queue concurrency limit</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <span>{queueConcurrencyLimit ?? "Not set"}</span>
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Env current concurrency key</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={withPrefix(keys.envCurrentConcurrencyKey(run.runtimeEnvironment))}
            variant="tertiary/small"
            iconButton
          />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Get env current concurrency</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={`SMEMBERS ${withPrefix(keys.envCurrentConcurrencyKey(run.runtimeEnvironment))}`}
            variant="tertiary/small"
            iconButton
          />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Env current concurrency</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <span>{envCurrentConcurrency ?? "0"}</span>
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Env reserve concurrency key</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={withPrefix(keys.envReserveConcurrencyKey(run.runtimeEnvironment.id))}
            variant="tertiary/small"
            iconButton
          />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Get env reserve concurrency</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={`SMEMBERS ${withPrefix(
              keys.envReserveConcurrencyKey(run.runtimeEnvironment.id)
            )}`}
            variant="tertiary/small"
            iconButton
          />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Env reserve concurrency</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <span>{envReserveConcurrency ?? "0"}</span>
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Env concurrency limit key</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={withPrefix(keys.envConcurrencyLimitKey(run.runtimeEnvironment))}
            variant="tertiary/small"
            iconButton
          />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>GET env concurrency limit</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={`GET ${withPrefix(keys.envConcurrencyLimitKey(run.runtimeEnvironment))}`}
            variant="tertiary/small"
            iconButton
          />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Env concurrency limit</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <span>{envConcurrencyLimit ?? "Not set"}</span>
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Shared queue key</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={`GET ${withPrefix(keys.envSharedQueueKey(run.runtimeEnvironment))}`}
            variant="tertiary/small"
            iconButton
          />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Get shared queue set</Property.Label>
        <Property.Value className="flex items-center gap-2">
          <ClipboardField
            value={`ZRANGEBYSCORE ${withPrefix(
              keys.envSharedQueueKey(run.runtimeEnvironment)
            )} -inf ${Date.now()} WITHSCORES`}
            variant="tertiary/small"
            iconButton
          />
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
}: UseDataFunctionReturn<typeof loader>) {
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
        <Property.Item>
          <Property.Label>{key.label}</Property.Label>
          <Property.Value className="flex items-center gap-2">
            <ClipboardField value={key.key} variant="tertiary/small" iconButton />
          </Property.Value>
        </Property.Item>
      ))}
    </Property.Table>
  );
}
