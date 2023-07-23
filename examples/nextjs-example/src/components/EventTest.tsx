"use client";

import { useQueryEvent, useQueryRun } from "@trigger.dev/react";
import styles from "@/styles/Home.module.css";

export function EventTest() {
  return (
    <div>
      <EventData id="clj73e44q00947c60kp0dpc37" />
      <RunData id="clj73e45f00957c60v1d06whu" />
    </div>
  );
}

function EventData({ id }: { id: string }) {
  const { isLoading, data, error } = useQueryEvent(id);

  return (
    <>
      <h1 className={styles.title}>Event</h1>
      {isLoading ? (
        <p>Loading</p>
      ) : error ? (
        JSON.stringify(error, null, 2)
      ) : (
        <code>
          <pre>{JSON.stringify(data, null, 2)}</pre>
        </code>
      )}
    </>
  );
}

function RunData({ id }: { id: string }) {
  const { isLoading, data, error } = useQueryRun(id);

  return (
    <>
      <h1 className={styles.title}>Run</h1>
      {isLoading ? (
        <p>Loading</p>
      ) : error ? (
        JSON.stringify(error, null, 2)
      ) : (
        <code>
          <pre>{JSON.stringify(data, null, 2)}</pre>
        </code>
      )}
    </>
  );
}
