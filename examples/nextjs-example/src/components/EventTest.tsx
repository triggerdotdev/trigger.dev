"use client";

import { useQueryEvent } from "@trigger.dev/react";

export function EventTest() {
  const { isLoading, data, error } = useQueryEvent("clj73e44q00947c60kp0dpc37");

  return (
    <>
      {isLoading ? (
        <p>Loading</p>
      ) : error ? (
        error
      ) : (
        <code>
          <pre>{JSON.stringify(data, null, 2)}</pre>
        </code>
      )}
    </>
  );
}
