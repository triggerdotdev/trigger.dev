"use client";

import { triggerStreamTask } from "@/app/actions";
import { useTransition } from "react";

export function TriggerButton({
  scenario,
  useDurableStreams,
  children,
  redirect,
}: {
  scenario: string;
  useDurableStreams?: boolean;
  children: React.ReactNode;
  redirect?: string;
}) {
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      await triggerStreamTask(scenario, redirect, useDurableStreams);
    });
  }

  return (
    <button
      onClick={handleClick}
      disabled={isPending}
      className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
    >
      {isPending ? "Triggering..." : children}
    </button>
  );
}
