"use client";

// @ts-ignore
import { useFormStatus } from "react-dom";
import { batchTriggerExampleTask } from "@/app/actions";
import { Button } from "@/components/ui/button";

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Running..." : "Run Batch Task"}
    </Button>
  );
}

export default function BatchRunTaskForm() {
  return (
    <form action={batchTriggerExampleTask}>
      <SubmitButton />
    </form>
  );
}
