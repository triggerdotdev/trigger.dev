"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { handleCSVUpload } from "@/trigger/csv";
import { CSVUploadMetadataSchema } from "@/trigger/schemas";
import { useRealtimeRun } from "@trigger.dev/react-hooks";
import { Terminal } from "lucide-react";

type UseCSVUploadInstance = {
  status: "loading" | "queued" | "fetching" | "parsing" | "processing" | "complete" | "error";
  filename?: string;
  progress: number;
  message: string;
  totalRows?: number;
  inProgressRows?: number;
  processedRows?: number;
};

function useCSVUpload(runId: string, accessToken: string): UseCSVUploadInstance {
  const instance = useRealtimeRun<typeof handleCSVUpload>(runId, {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
    onComplete: (run) => {
      console.log("CSV Upload complete", run);
    },
    stopOnCompletion: false,
  });

  if (!instance.run) {
    return { status: "loading", progress: 0, message: "Loading..." };
  }

  console.log("CSV Upload", instance.run);

  if (!instance.run.metadata) {
    return {
      status: "queued",
      progress: 0.05,
      message: "Queued...",
      filename: instance.run.payload.name,
    };
  }

  const parsedMetadata = CSVUploadMetadataSchema.safeParse(instance.run.metadata);

  if (!parsedMetadata.success) {
    return {
      status: "error",
      progress: 0,
      message: "Failed to parse metadata",
      filename: instance.run.payload.name,
    };
  }

  switch (parsedMetadata.data.status) {
    case "fetching": {
      return {
        status: "fetching",
        progress: 0.1,
        message: "Fetching CSV file...",
        filename: instance.run.payload.name,
      };
    }
    case "parsing": {
      return {
        status: "parsing",
        progress: 0.2,
        message: "Parsing CSV file...",
        filename: instance.run.payload.name,
      };
    }
    case "processing": {
      // progress will be some number between 0.3 and 0.95
      // depending on the totalRows and processedRows

      const progress =
        typeof parsedMetadata.data.processedRows === "number" &&
        typeof parsedMetadata.data.totalRows === "number"
          ? 0.3 + (parsedMetadata.data.processedRows / parsedMetadata.data.totalRows) * 0.65
          : 0.3;

      return {
        status: "processing",
        progress: progress,
        message: "Processing CSV file...",
        totalRows: parsedMetadata.data.totalRows,
        inProgressRows: parsedMetadata.data.inProgressRows,
        processedRows: parsedMetadata.data.processedRows,
        filename: instance.run.payload.name,
      };
    }
    case "complete": {
      return {
        status: "complete",
        progress: 1,
        message: "CSV processing complete",
        totalRows: parsedMetadata.data.totalRows,
        inProgressRows: parsedMetadata.data.inProgressRows,
        processedRows: parsedMetadata.data.processedRows,
        filename: instance.run.payload.name,
      };
    }
  }
}

export default function RealtimeCSVRun({
  runId,
  accessToken,
}: {
  runId: string;
  accessToken: string;
}) {
  const csvRun = useCSVUpload(runId, accessToken);

  const progress = Math.round(csvRun.progress * 100);
  const isComplete = csvRun.status === "complete";

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center gap-2 mb-8">
          <Terminal className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">CSV Email Validation</h1>
        </div>

        <Card>
          <CardHeader>
            <div className="flex justify-between items-start">
              <div>
                <CardTitle>{csvRun.filename ?? "n/a"}</CardTitle>
                <CardDescription>
                  {csvRun.totalRows ? `Processing ${csvRun.totalRows} rows` : "Processing CSV file"}
                </CardDescription>
              </div>
              <Badge variant="outline" className={isComplete ? "bg-green-500/10" : "bg-primary/10"}>
                {isComplete ? "Completed" : "Running"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Overall Progress</span>
                <span className="font-mono">{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold">
                    {typeof csvRun.processedRows === "number" ? csvRun.processedRows : "N/A"}
                  </div>
                  <div className="text-sm text-muted-foreground">Emails Processed</div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold">
                    {typeof csvRun.totalRows === "number"
                      ? csvRun.totalRows - (csvRun.processedRows ?? 0)
                      : "N/A"}
                  </div>
                  <div className="text-sm text-muted-foreground">Remaining</div>
                </CardContent>
              </Card>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
