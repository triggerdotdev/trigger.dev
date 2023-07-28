"use server";

import { redirect } from "next/navigation";
import { client } from "./trigger";

export async function sendReactHookEvent(data: FormData) {
  const event = await client.sendEvent({
    name: "react-hook",
  });

  redirect(`/events/${event.id}`);
}
