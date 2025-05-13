"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertCircle, CheckCircle2, Clock, FileText, Loader2, RefreshCw } from "lucide-react";

type BatchStatus = "validating" | "in_progress" | "completed" | "failed" | "expired";

interface BatchInfo {
  id: string;
  status: BatchStatus;
  totalRequests: number;
  completedRequests: number;
  failedRequests: number;
  inputFileName: string;
  outputFileName: string | null;
  errorFileName: string | null;
  createdAt: string;
  completedAt: string | null;
}

export default function BatchProgressIndicator() {
  const [batchInfo, setBatchInfo] = useState<BatchInfo>({
    id: "batch_abc123",
    status: "in_progress",
    totalRequests: 1000,
    completedRequests: 750,
    failedRequests: 10,
    inputFileName: "input.jsonl",
    outputFileName: null,
    errorFileName: null,
    createdAt: "2023-03-15T10:30:00Z",
    completedAt: null,
  });
  const [lastCheckedAt, setLastCheckedAt] = useState<string>(new Date().toISOString());

  useEffect(() => {
    // Simulate progress
    const interval = setInterval(() => {
      setBatchInfo((prev) => ({
        ...prev,
        completedRequests: Math.min(prev.completedRequests + 10, prev.totalRequests),
        status: prev.completedRequests + 10 >= prev.totalRequests ? "completed" : prev.status,
        completedAt:
          prev.completedRequests + 10 >= prev.totalRequests ? new Date().toISOString() : null,
        outputFileName: prev.completedRequests + 10 >= prev.totalRequests ? "output.jsonl" : null,
      }));
      setLastCheckedAt(new Date().toISOString());
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const getStatusIcon = (status: BatchStatus) => {
    switch (status) {
      case "validating":
      case "in_progress":
        return <Loader2 className="w-4 h-4 animate-spin" />;
      case "completed":
        return <CheckCircle2 className="w-4 h-4 text-green-600" />;
      case "failed":
        return <AlertCircle className="w-4 h-4 text-red-600" />;
      case "expired":
        return <Clock className="w-4 h-4 text-yellow-600" />;
    }
  };

  const getStatusColor = (status: BatchStatus) => {
    switch (status) {
      case "validating":
      case "in_progress":
        return "bg-blue-100 text-blue-800 border-blue-300";
      case "completed":
        return "bg-green-100 text-green-800 border-green-300";
      case "failed":
        return "bg-red-100 text-red-800 border-red-300";
      case "expired":
        return "bg-yellow-100 text-yellow-800 border-yellow-300";
    }
  };

  return (
    <Card className="w-full max-w-2xl bg-white text-gray-800 border border-gray-200 shadow-sm font-mono">
      <CardHeader className="border-b border-gray-200">
        <CardTitle className="flex items-center justify-between text-lg">
          <span className="font-bold">Batch Progress: {batchInfo.id}</span>
          <Badge
            variant="outline"
            className={`${getStatusColor(
              batchInfo.status
            )} px-2 py-1 text-xs font-semibold rounded border`}
          >
            {getStatusIcon(batchInfo.status)}
            <span className="ml-2 capitalize">{batchInfo.status.replace("_", " ")}</span>
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        <div className="flex justify-between text-sm">
          <span>Progress</span>
          <span className="font-bold">
            {Math.round((batchInfo.completedRequests / batchInfo.totalRequests) * 100)}%
          </span>
        </div>
        <Progress
          value={(batchInfo.completedRequests / batchInfo.totalRequests) * 100}
          className="h-2 bg-gray-200"
        />
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="bg-gray-50 p-2 rounded">
            <p className="text-gray-500">Total Requests</p>
            <p className="font-bold">{batchInfo.totalRequests}</p>
          </div>
          <div className="bg-gray-50 p-2 rounded">
            <p className="text-gray-500">Completed</p>
            <p className="font-bold">{batchInfo.completedRequests}</p>
          </div>
          <div className="bg-gray-50 p-2 rounded">
            <p className="text-gray-500">Failed</p>
            <p className="font-bold">{batchInfo.failedRequests}</p>
          </div>
          <div className="bg-gray-50 p-2 rounded">
            <p className="text-gray-500">Created At</p>
            <p className="font-bold">{new Date(batchInfo.createdAt).toLocaleString()}</p>
          </div>
          <div className="bg-gray-50 p-2 rounded col-span-2">
            <p className="text-gray-500">Last Checked At</p>
            <p className="font-bold">{new Date(lastCheckedAt).toLocaleString()}</p>
          </div>
        </div>
        <div className="space-y-2 bg-gray-50 p-2 rounded">
          <div className="flex items-center space-x-2">
            <FileText className="w-4 h-4 text-gray-500" />
            <span className="text-sm">
              Input: <span className="font-bold">{batchInfo.inputFileName}</span>
            </span>
          </div>
          {batchInfo.outputFileName && (
            <div className="flex items-center space-x-2">
              <FileText className="w-4 h-4 text-gray-500" />
              <span className="text-sm">
                Output: <span className="font-bold">{batchInfo.outputFileName}</span>
              </span>
            </div>
          )}
          {batchInfo.errorFileName && (
            <div className="flex items-center space-x-2">
              <FileText className="w-4 h-4 text-gray-500" />
              <span className="text-sm">
                Errors: <span className="font-bold">{batchInfo.errorFileName}</span>
              </span>
            </div>
          )}
        </div>
        <div className="flex justify-end space-x-2">
          <Button
            variant="outline"
            size="sm"
            className="text-blue-600 border-blue-300 hover:bg-blue-50"
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="bg-red-100 text-red-600 hover:bg-red-200 border border-red-300"
            disabled={
              batchInfo.status === "completed" ||
              batchInfo.status === "failed" ||
              batchInfo.status === "expired"
            }
          >
            Cancel Batch
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
