"use client";

import { Card, CardContent } from "@/components/ui/card";
import type { exampleTask } from "@/trigger/example";
import { useRealtimeBatch } from "@trigger.dev/react-hooks";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AnyRunShape, TaskRunShape } from "@trigger.dev/sdk/v3";
import { z } from "zod";

const MetadataSchema = z.object({
  status: z.object({
    type: z.string(),
    progress: z.number(),
  }),
});

const ProgressBar = ({ run }: { run: AnyRunShape }) => {
  const metadata = run.metadata ? MetadataSchema.parse(run.metadata) : undefined;
  const progress = metadata?.status.progress || 0;

  return (
    <div className="w-full">
      <div className="text-xs text-gray-500 mb-1">
        {metadata ? metadata.status.type : "waiting..."}
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2.5 dark:bg-gray-700">
        <div
          className="bg-blue-600 h-2.5 rounded-full transition-all duration-500 ease-in-out"
          style={{ width: `${progress * 100}%` }}
        ></div>
      </div>
    </div>
  );
};

const StatusBadge = ({ run }: { run: AnyRunShape }) => {
  switch (run.status) {
    case "WAITING_FOR_DEPLOY": {
      return <Badge className={`bg-purple-800 text-purple-100 font-semibold`}>{run.status}</Badge>;
    }
    case "DELAYED": {
      return <Badge className={`bg-yellow-800 text-yellow-100 font-semibold`}>{run.status}</Badge>;
    }
    case "EXPIRED": {
      return <Badge className={`bg-red-800 text-red-100 font-semibold`}>{run.status}</Badge>;
    }
    case "QUEUED": {
      return <Badge className={`bg-yellow-800 text-yellow-100 font-semibold`}>{run.status}</Badge>;
    }
    case "FROZEN":
    case "REATTEMPTING":
    case "EXECUTING": {
      return <Badge className={`bg-blue-800 text-blue-100 font-semibold`}>{run.status}</Badge>;
    }
    case "COMPLETED": {
      return <Badge className={`bg-green-800 text-green-100 font-semibold`}>{run.status}</Badge>;
    }
    case "TIMED_OUT":
    case "SYSTEM_FAILURE":
    case "INTERRUPTED":
    case "CRASHED":
    case "FAILED": {
      return <Badge className={`bg-red-800 text-red-100 font-semibold`}>{run.status}</Badge>;
    }
    case "CANCELED": {
      return <Badge className={`bg-gray-800 text-gray-100 font-semibold`}>{run.status}</Badge>;
    }
    default: {
      return <Badge className={`bg-gray-800 text-gray-100 font-semibold`}>{run.status}</Badge>;
    }
  }
};

export function BackgroundRunsTable({ runs }: { runs: TaskRunShape<typeof exampleTask>[] }) {
  return (
    <div className="max-w-6xl mx-auto mt-8">
      <h1 className="text-gray-200 text-2xl font-semibold mb-8">Recent Background Runs</h1>
      <Table>
        <TableHeader>
          <TableRow className="border-b border-gray-700">
            <TableHead className="w-[150px] text-gray-200 text-base">Run ID / Task</TableHead>
            <TableHead className="text-gray-200 text-base">Status</TableHead>
            <TableHead className="text-gray-200 text-base">Payload ID</TableHead>
            <TableHead className="w-[200px] text-gray-200 text-base">Progress</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.id} className="border-b border-gray-700 hover:bg-gray-800">
              <TableCell>
                <div className="font-medium">{run.id}</div>
                <div className="text-sm text-gray-500">{run.taskIdentifier}</div>
              </TableCell>
              <TableCell>
                <StatusBadge run={run} />
              </TableCell>
              <TableCell>{run.payload.id}</TableCell>
              <TableCell>
                <ProgressBar run={run} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function BatchRunTableWrapper({
  batchId,
  publicAccessToken,
}: {
  batchId: string;
  publicAccessToken: string;
}) {
  const { runs, error } = useRealtimeBatch<typeof exampleTask>(batchId, {
    accessToken: publicAccessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });

  console.log(runs);

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

  return (
    <div className="w-full min-h-screen bg-gray-900 text-gray-200 p-4 space-y-6">
      <BackgroundRunsTable runs={runs} />
    </div>
  );
}

export default function ClientBatchRunDetails({ batchId, jwt }: { batchId: string; jwt: string }) {
  return <BatchRunTableWrapper batchId={batchId} publicAccessToken={jwt} />;
}
