"use client";

import { redirect } from "next/navigation";
import { useMutation } from "react-query";

export function SendTestEventButton() {
  const mutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/send-test-event");
      const data = await response.json();
      console.log("event", data);
      redirect(`/events/${data.id}`);
    },
  });

  return (
    <button
      onClick={() => {
        mutation.mutate();
      }}
    >
      Send test event
    </button>
  );
}
