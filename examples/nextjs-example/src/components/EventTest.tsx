"use client";

import { useEventDetails, useRunDetails } from "@trigger.dev/react";
import styles from "@/styles/Home.module.css";

export function EventTest() {
  return (
    <div>
      <EventData id="clj73e44q00947c60kp0dpc37" />
      <RunData id="cljykui9y00027coa4o3lxmuq" />
    </div>
  );
}

function EventData({ id }: { id: string }) {
  const { isLoading, data, error } = useEventDetails(id);

  return (
    <>
      <h1 className={styles.title}>Event</h1>
      {isLoading ? (
        <p>Loading</p>
      ) : error ? (
        JSON.stringify(error, null, 2)
      ) : data ? (
        <p>
          <strong>Event ID:</strong> {data.id}
        </p>
      ) : (
        <p></p>
      )}
    </>
  );
}

function RunData({ id }: { id: string }) {
  const { isLoading, isError, data, error } = useRunDetails(id, {
    subtasks: true,
    refreshInterval: 1000,
  });

  if (isLoading) {
    return <p>Loading...</p>;
  }

  if (isError) {
    return <p>Error</p>;
  }

  return (
    <>
      <div>Run status: {data.status}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {data.tasks.map((task) => (
          <div key={task.id}>
            <h4>{task.name}</h4>
            <p>Status: {task.status}</p>
          </div>
        ))}
      </div>
    </>
  );
}
