"use client";

import { useMutation } from "react-query";
import { useRouter } from "next/navigation";

export function SendTestEventButton() {
  const router = useRouter();
  const mutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/send-test-event");
      const data = await response.json();
      console.log("event", data);
      router.push(`/events/${data.id}`);
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
