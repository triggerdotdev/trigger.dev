"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AnyRunShape, TaskRunShape } from "@trigger.dev/sdk/v3";
import { ExternalLink } from "lucide-react";
import type { handleUpload } from "@/trigger/images";

interface HandleUploadFooterProps {
  run: TaskRunShape<typeof handleUpload>;
  viewRunUrl: string;
}

export function HandleUploadFooter({ run, viewRunUrl }: HandleUploadFooterProps) {
  const getStatusColor = (status: AnyRunShape["status"]) => {
    switch (status) {
      case "EXECUTING":
        return "bg-blue-500";
      case "COMPLETED":
        return "bg-green-500";
      case "FAILED":
        return "bg-red-500";
      default:
        return "bg-gray-500";
    }
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-background border-t border-border p-4 shadow-lg">
      <div className="container mx-auto flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <span className="text-sm font-medium">Run ID: {run.id}</span>
          <span className="text-sm">Processing {run.payload.name}</span>
          <Badge variant="secondary" className={`${getStatusColor(run.status)} text-white`}>
            {run.status}
          </Badge>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a
            href={viewRunUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center"
          >
            View Run
            <ExternalLink className="ml-2 h-4 w-4" />
          </a>
        </Button>
      </div>
    </div>
  );
}
