"use client";

// @ts-ignore
import { useFormStatus } from "react-dom";
import { triggerExampleTask } from "@/app/actions";
import { Button } from "@/components/ui/button";

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Running..." : "Run Task"}
    </Button>
  );
}

export default function RunTaskForm() {
  return (
    <form action={triggerExampleTask}>
      <SubmitButton />
    </form>
  );
}
