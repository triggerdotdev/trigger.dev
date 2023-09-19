"use client";

import {
  useEventDetails,
  useEventRunDetails,
  useRunDetails,
  useTriggerProvider,
} from "@trigger.dev/react";
import Link from "next/link";

export function ReactHooks({ eventId }: { eventId: string }) {
  const providerData = useTriggerProvider();
  const { isSuccess, isLoading, isError, data, error } = useEventRunDetails(eventId);

  const event = useEventDetails(eventId);
  console.log("event.data", event.data);

  const run = useRunDetails(event.data?.runs?.at(0)?.id);
  console.log("run.data", run.data);

  if (!isSuccess) {
    return <p>Error</p>;
  }

  return (
    <div>
      <h2 className="text-lg">useTriggerProvider()</h2>
      <code>
        <pre>
          {providerData !== undefined && providerData.publicApiKey !== null && "✅ Working"}
        </pre>
      </code>

      <h2 className="text-lg">useEventRunDetails()</h2>

      <div className="w-full flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <>
            <ProgressItem
              state={
                data?.tasks === undefined || data.tasks.length === 0 ? "progress" : "completed"
              }
              name="Starting up"
            />
            {data?.tasks?.map((task) => (
              <ProgressItem
                key={task.id}
                state={
                  task.status === "COMPLETED"
                    ? "completed"
                    : task.status === "ERRORED"
                    ? "failed"
                    : "progress"
                }
                name={task.displayKey ?? task.name ?? ""}
                icon={task.icon ?? undefined}
              />
            ))}
          </>
        </div>
        {data?.output && data.status === "SUCCESS" && (
          <div className="flex flex-col gap-0.5">
            <h4 className="text-base font-semibold">Output</h4>
            <p className="text-slate-400 text-sm mb-4">{data.output.summary}</p>
          </div>
        )}
        {(data?.status === "SUCCESS" || data?.status === "FAILURE") && (
          <Link className="border border-slate-500 p-2 text-center" href={"/"}>
            Back to home
          </Link>
        )}
      </div>
    </div>
  );
}

type ProgressItemProps = {
  icon?: string;
  state: "progress" | "completed" | "failed";
  name: string;
};

function ProgressItem({ icon, state, name }: ProgressItemProps) {
  return (
    <div className="flex gap-2 items-center">
      {state === "progress" ? "⏳" : state === "completed" ? "✅" : "⛔️"}
      <div className="flex gap-1.5 items-center">
        {icon}
        <h4 className="text-base">{name}</h4>
      </div>
    </div>
  );
}
