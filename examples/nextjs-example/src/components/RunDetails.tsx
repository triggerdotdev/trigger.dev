"use client";

import styles from "@/styles/Home.module.css";
import {
  useEventDetails,
  useEventRunDetails,
  useRunDetails,
} from "@trigger.dev/react";

export function EventData({ id }: { id: string }) {
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

export function RunData({ id }: { id: string }) {
  const { isLoading, isError, data, error } = useRunDetails(id);

  if (isLoading) {
    return <p>Loading...</p>;
  }

  if (isError) {
    return <p>Error</p>;
  }

  if (!data) {
    return <p>Loading...</p>;
  }

  return (
    <>
      <div>Run status: {data.status}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
        {data.tasks.map((task) => (
          <div key={task.id} style={{ display: "flex", gap: "0.5rem" }}>
            <h4>{task.name}</h4>
            <p>Status: {task.status}</p>
          </div>
        ))}
      </div>
    </>
  );
}

export function EventRunData({ id }: { id: string }) {
  const { isLoading, isError, data, error } = useEventRunDetails(id);

  if (isLoading) {
    return <p>Loading...</p>;
  }

  if (isError) {
    return <p>Error</p>;
  }

  if (!data) {
    return <p>Loading...</p>;
  }

  return (
    <>
      <div>Run status: {data.status}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
        {data.tasks.map((task) => (
          <div
            key={task.id}
            style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}
          >
            <h4>{task.displayKey ?? task.name}</h4>
            <p>{task.icon}</p>
            <p>Status: {task.status}</p>
          </div>
        ))}
      </div>
    </>
  );
}
