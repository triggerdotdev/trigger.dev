"use client";

import RunDetails from "@/components/RunDetails";
import { Card, CardContent } from "@/components/ui/card";
import { TriggerAuthContext, useRun } from "@trigger.dev/react-hooks";
import type { exampleTask } from "@/trigger/example";

function RunDetailsWrapper({ runId }: { runId: string }) {
  const { run, error } = useRun<typeof exampleTask>(runId);

  if (error) {
    return (
      <div className="w-full min-h-screen bg-gray-100 p-4">
        <Card className="w-full bg-white shadow-md">
          <CardContent className="pt-6">
            <p className="text-red-600">Error: {error.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="w-full min-h-screen bg-gray-100 p-4">
        <Card className="w-full bg-white shadow-md">
          <CardContent className="pt-6">
            <p>Loading run details...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="w-full min-h-screen bg-gray-100 p-4 space-y-6">
      <RunDetails record={run} />
    </div>
  );
}

export default function ClientRunDetails({ runId, jwt }: { runId: string; jwt: string }) {
  console.log("ClientRunDetails", runId, jwt);

  return (
    <TriggerAuthContext.Provider value={{ accessToken: jwt, baseURL: "http://localhost:3030" }}>
      <RunDetailsWrapper runId={runId} />
    </TriggerAuthContext.Provider>
  );
}
