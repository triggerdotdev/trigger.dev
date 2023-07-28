"use server";

import { redirect } from "next/navigation";
import { client } from "./trigger";

export async function sendReactHookEvent(data: FormData) {
  const event = await client.sendEvent({
    name: "react-hook",
  });

  const eventDetails = await client.getEvent(event.id);
  console.log("eventDetails", eventDetails);

  const runs = await client.getRuns("react-hook");
  console.log("runs", runs);

  if (runs.runs[0]) {
    const runDetails = await client.getRun(runs.runs[0].id);
    console.log("runDetails", runDetails);
  }

  redirect(`/events/${event.id}`);
}
