"use client";

import { Card, CardContent } from "@/components/ui/card";
import { TriggerAuthContext, useBatch } from "@trigger.dev/react-hooks";
import type { exampleTask } from "@/trigger/example";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TaskRunShape, AnyRunShape } from "@trigger.dev/sdk/v3";
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
      return <Badge className={`bg-purple-100 text-purple-800 font-semibold`}>{run.status}</Badge>;
    }
    case "DELAYED": {
      return <Badge className={`bg-yellow-100 text-yellow-800 font-semibold`}>{run.status}</Badge>;
    }
    case "EXPIRED": {
      return <Badge className={`bg-red-100 text-red-800 font-semibold`}>{run.status}</Badge>;
    }
    case "QUEUED": {
      return <Badge className={`bg-yellow-100 text-yellow-800 font-semibold`}>{run.status}</Badge>;
    }
    case "FROZEN":
    case "REATTEMPTING":
    case "EXECUTING": {
      return <Badge className={`bg-blue-100 text-blue-800 font-semibold`}>{run.status}</Badge>;
    }
    case "COMPLETED": {
      return <Badge className={`bg-green-100 text-green-800 font-semibold`}>{run.status}</Badge>;
    }
    case "TIMED_OUT":
    case "SYSTEM_FAILURE":
    case "INTERRUPTED":
    case "CRASHED":
    case "FAILED": {
      return <Badge className={`bg-red-100 text-red-800 font-semibold`}>{run.status}</Badge>;
    }
    case "CANCELED": {
      return <Badge className={`bg-gray-100 text-gray-800 font-semibold`}>{run.status}</Badge>;
    }
    default: {
      return <Badge className={`bg-gray-100 text-gray-800 font-semibold`}>{run.status}</Badge>;
    }
  }
};

export function BackgroundRunsTable({ runs }: { runs: TaskRunShape<typeof exampleTask>[] }) {
  return (
    <Table>
      <TableCaption>A list of your recent background runs.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[150px]">Run ID / Task</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Payload ID</TableHead>
          <TableHead className="w-[200px]">Progress</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id}>
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
  );
}

function BatchRunTableWrapper({ batchId }: { batchId: string }) {
  const { runs, error } = useBatch<typeof exampleTask>(batchId);

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
    <div className="w-full min-h-screen bg-gray-100 p-4 space-y-6">
      <BackgroundRunsTable runs={runs} />
    </div>
  );
}

export default function ClientBatchRunDetails({ batchId, jwt }: { batchId: string; jwt: string }) {
  return (
    <TriggerAuthContext.Provider
      value={{ accessToken: jwt, baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL }}
    >
      <BatchRunTableWrapper batchId={batchId} />
    </TriggerAuthContext.Provider>
  );
}
