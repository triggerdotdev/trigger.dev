"use client";

import { sendReactHookEvent } from "../_actions";

export default function SendReactHookEventForm() {
  return (
    <form action={sendReactHookEvent}>
      <button className="border border-slate-600 rounded-sm p-2">Send react-hook event</button>
    </form>
  );
}
