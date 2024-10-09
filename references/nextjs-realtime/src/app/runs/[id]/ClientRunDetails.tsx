"use client";

import { AuthProvider } from "@/contexts/AuthContext";
import { useRunSubscription } from "@/hooks/useRunSubscription";
import RunDetails from "@/components/RunDetails";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

function RunDetailsWrapper({ runId }: { runId: string }) {
  const { runUpdates, error } = useRunSubscription(runId);

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

  if (runUpdates.length === 0) {
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

  const latestRun = runUpdates[runUpdates.length - 1];

  return (
    <div className="w-full min-h-screen bg-gray-100 p-4 space-y-6">
      <Card className="w-full bg-white shadow-md">
        <CardHeader>
          <CardTitle>Latest Run State</CardTitle>
        </CardHeader>
        <CardContent>
          <RunDetails record={latestRun} />
        </CardContent>
      </Card>

      <Card className="w-full bg-white shadow-md">
        <CardHeader>
          <CardTitle>Run Update History</CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[400px]">
            {runUpdates.map((run, index) => (
              <div key={index} className="mb-4 p-4 border rounded">
                <RunDetails record={run} />
              </div>
            ))}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

export default function ClientRunDetails({ runId, jwt }: { runId: string; jwt: string }) {
  return (
    <AuthProvider accessToken={jwt} baseURL="http://localhost:3030">
      <RunDetailsWrapper runId={runId} />
    </AuthProvider>
  );
}
