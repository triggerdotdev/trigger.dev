"use client";

// @ts-ignore
import { useFormStatus } from "react-dom";
import { triggerExampleTask } from "@/app/actions";
import { Button } from "@/components/ui/button";

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      disabled={pending}
      className="p-0 bg-transparent hover:bg-transparent hover:text-gray-200 text-gray-400"
    >
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
