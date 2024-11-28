import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { exampleTask } from "@/trigger/example";
import type { TaskRunShape } from "@trigger.dev/sdk/v3";
import { AlertTriangleIcon, CheckCheckIcon, XIcon } from "lucide-react";

function formatDate(date: Date | undefined) {
  return date ? new Date(date).toLocaleString() : "N/A";
}

function JsonDisplay({ data }: { data: any }) {
  return (
    <ScrollArea className="h-[200px] w-full rounded-md border p-4 bg-gray-900 border-gray-700">
      <pre className="text-sm">{JSON.stringify(data, null, 2)}</pre>
    </ScrollArea>
  );
}

export default function RunDetails({ record }: { record: TaskRunShape<typeof exampleTask> }) {
  return (
    <Card className="w-full max-w-4xl mx-auto bg-gray-800 border-gray-700 text-gray-200">
      <CardHeader>
        <CardTitle className="text-2xl font-bold">Run Details</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <h3 className="font-semibold mb-1">ID</h3>
            <p className="text-sm">{record.id}</p>
          </div>
          <div>
            <h3 className="font-semibold mb-1">Task Identifier</h3>
            <p className="text-sm">{record.taskIdentifier}</p>
          </div>
          <div>
            <h3 className="font-semibold mb-1">Status</h3>
            <Badge variant={record.status === "COMPLETED" ? "default" : "secondary"}>
              {record.status}
            </Badge>
          </div>
          <div>
            <h3 className="font-semibold mb-1">Is Test</h3>
            {record.isTest ? (
              <span className="text-gray-200 flex items-center gap-1 text-sm">
                <CheckCheckIcon className="size-4 text-green-500" />
                Yes
              </span>
            ) : (
              <span className="text-gray-200 flex items-center gap-1 text-sm">
                <XIcon className="size-4" /> No
              </span>
            )}
          </div>
          {record.idempotencyKey && (
            <div>
              <h3 className="font-semibold mb-1">Idempotency Key</h3>
              <p className="text-sm">{record.idempotencyKey}</p>
            </div>
          )}
          {record.ttl && (
            <div>
              <h3 className="font-semibold mb-1">TTL</h3>
              <p className="text-sm">{record.ttl}</p>
            </div>
          )}
        </div>

        <div>
          <h3 className="font-semibold mb-1">Tags</h3>
          <div className="flex flex-wrap gap-2">
            {record.tags.length > 0 ? (
              record.tags.map((tag, index) => (
                <Badge key={index} variant="outline">
                  {tag}
                </Badge>
              ))
            ) : (
              <span className="text-sm text-muted-foreground">No tags</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <h3 className="font-semibold mb-1">Created At</h3>
            <p className="text-sm">{formatDate(record.createdAt)}</p>
          </div>
          <div>
            <h3 className="font-semibold mb-1">Updated At</h3>
            <p className="text-sm">{formatDate(record.updatedAt)}</p>
          </div>
          <div>
            <h3 className="font-semibold mb-1">Started At</h3>
            <p className="text-sm">{formatDate(record.startedAt)}</p>
          </div>
          <div>
            <h3 className="font-semibold mb-1">Finished At</h3>
            <p className="text-sm">{formatDate(record.finishedAt)}</p>
          </div>
          <div>
            <h3 className="font-semibold mb-1">Delayed Until</h3>
            <p className="text-sm">{formatDate(record.delayedUntil)}</p>
          </div>
          <div>
            <h3 className="font-semibold mb-1">Expired At</h3>
            <p className="text-sm">{formatDate(record.expiredAt)}</p>
          </div>
        </div>

        <div>
          <h3 className="font-semibold mb-1">Payload</h3>
          <JsonDisplay data={record.payload} />
        </div>

        {record.output && (
          <div>
            <h3 className="font-semibold mb-1">Output</h3>
            <p className="text-sm">{record.output.message}</p>
          </div>
        )}

        {record.metadata && (
          <div>
            <h3 className="font-semibold mb-1">Metadata</h3>
            <JsonDisplay data={record.metadata} />
          </div>
        )}

        {record.error && (
          <div>
            <h3 className="font-semibold mb-1 flex items-center gap-1 text-rose-500">
              <AlertTriangleIcon className="size-5" /> Error
            </h3>
            <Card className="bg-gray-900 border-rose-500">
              <CardContent className="pt-6">
                <p className="font-semibold text-rose-500">{record.error.name}</p>
                <p className="text-sm text-rose-500">{record.error.message}</p>
                {record.error.stackTrace && (
                  <ScrollArea className="h-[100px] w-full mt-2">
                    <pre className="text-xs text-rose-800">{record.error.stackTrace}</pre>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
