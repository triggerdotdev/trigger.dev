"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AnyRunShape, TaskRunShape } from "@trigger.dev/sdk/v3";
import { ChevronLeft, ExternalLink } from "lucide-react";
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
    <div className="fixed flex items-center justify-between bottom-0 left-0 right-0 bg-gray-800 border-t border-gray-700 p-4">
      <Button variant="outline" size="sm" asChild>
        <a
          href="/"
          rel="noopener noreferrer"
          className="flex items-center bg-green-700 text-white px-2 py-1 rounded-md border-transparent hover:bg-green-600 hover:text-white"
        >
          <ChevronLeft className="mr-1 size-4" />
          Upload another image
        </a>
      </Button>
      <div className="flex items-center space-x-4">
        <span className="text-sm font-medium">Run ID: {run.id}</span>
        <span className="text-gray-400">|</span>
        <span className="text-sm">Processing {run.payload.name}</span>
        <Badge variant="secondary" className={`${getStatusColor(run.status)} text-gray-200`}>
          {run.status}
        </Badge>
      </div>
      <Button variant="outline" size="sm" asChild>
        <a
          href={viewRunUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center bg-green-700 text-white px-2 py-1 rounded-md border-transparent hover:bg-green-600 hover:text-white"
        >
          View Run
          <ExternalLink className="ml-2 size-4" />
        </a>
      </Button>
    </div>
  );
}
