"use client";

import { triggerExampleTask } from "@/app/actions";
import { Button } from "@/components/ui/button";

export default function RunButton() {
  return (
    <Button
      onClick={async () => {
        await triggerExampleTask();
      }}
    >
      Run Task
    </Button>
  );
}
