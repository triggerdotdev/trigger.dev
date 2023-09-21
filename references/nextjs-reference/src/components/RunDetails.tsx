"use client";

import { useEventRunStatuses } from "@trigger.dev/react";

export function EventRunData({ id }: { id: string }) {
  const { fetchStatus, error, statuses, run } = useEventRunStatuses(id);

  if (fetchStatus === "loading") {
    return <p>Loading...</p>;
  }

  if (fetchStatus === "error") {
    return (
      <div>
        <p>{error.name}</p>
        <p>{error.message}</p>
      </div>
    );
  }

  return (
    <>
      <div>Run status: {run.status}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
        {statuses.map((status) => {
          switch (status.key) {
            case "getting-input-data": {
              return (
                <div key={status.key}>
                  <h4>{status.label}</h4>
                  <p>Status: {status.state}</p>
                </div>
              );
            }
            case "generating-memes": {
              const urls = status.data?.urls as string[] | undefined;
              return (
                <div key={status.key}>
                  {urls?.map((url) => <img key={url} src={url} style={{ display: "block" }} />)}
                </div>
              );
            }
          }
        })}
      </div>
      {run.output && (
        <code>
          <pre>{JSON.stringify(run.output, null, 2)}</pre>
        </code>
      )}
    </>
  );
}
