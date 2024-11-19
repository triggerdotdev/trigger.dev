"use client";

import RunDetails from "@/components/RunDetails";
import { Card, CardContent } from "@/components/ui/card";
import { TriggerAuthContext, useRealtimeRun } from "@trigger.dev/react-hooks";
import type { exampleTask } from "@/trigger/example";

function RunDetailsWrapper({
  runId,
  publicAccessToken,
}: {
  runId: string;
  publicAccessToken: string;
}) {
  const { run, error } = useRealtimeRun<typeof exampleTask>(runId, {
    accessToken: publicAccessToken,
  });

  if (error) {
    return (
      <div className="w-full min-h-screen bg-gray-900 p-4">
        <Card className="w-full bg-gray-800 shadow-md">
          <CardContent className="pt-6">
            <p className="text-red-600">Error: {error.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="w-full min-h-screen bg-gray-900 py-4 px-6 grid place-items-center">
        <Card className="w-fit bg-gray-800 border border-gray-700 shadow-md">
          <CardContent className="pt-6">
            <p className="text-gray-200">Loading run details…</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="w-full min-h-screen bg-gray-900 text-gray-200 p-4 space-y-6">
      <RunDetails record={run} />
    </div>
  );
}

export default function ClientRunDetails({ runId, jwt }: { runId: string; jwt: string }) {
  return (
    <TriggerAuthContext.Provider value={{ baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL }}>
      <RunDetailsWrapper runId={runId} publicAccessToken={jwt} />
    </TriggerAuthContext.Provider>
  );
}
