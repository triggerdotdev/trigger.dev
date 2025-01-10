"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Upload, AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useRealtimeRun, useTaskTrigger } from "@trigger.dev/react-hooks";
import type { openaiBatch } from "@/trigger/openaiBatch";

export default function BatchSubmissionForm({ accessToken }: { accessToken: string }) {
  const trigger = useTaskTrigger<typeof openaiBatch>("openai-batch", {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });

  const { run } = useRealtimeRun<typeof openaiBatch>(trigger.handle?.id, {
    accessToken: trigger.handle?.publicAccessToken,
    enabled: !!trigger.handle,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });

  const [jsonlContent, setJsonlContent] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    trigger.submit({
      jsonl: jsonlContent,
    });
  };

  return (
    <Card className="w-full max-w-2xl bg-white text-gray-800 border border-gray-200 shadow-sm font-mono">
      <CardHeader className="border-b border-gray-200">
        <CardTitle className="text-lg font-bold">Submit Batch Job</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="jsonl-input" className="block text-sm font-medium text-gray-700 mb-1">
              JSONL Content
            </label>
            <Textarea
              id="jsonl-input"
              value={jsonlContent}
              onChange={(e) => setJsonlContent(e.target.value)}
              placeholder="Paste your JSONL content here..."
              className="w-full h-48 p-2 text-sm bg-gray-50 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
              required
            />
          </div>
          {trigger.error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{trigger.error.message}</AlertDescription>
            </Alert>
          )}
          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={trigger.isLoading || !jsonlContent.trim()}
              className="bg-blue-600 text-white hover:bg-blue-700 focus:ring-4 focus:ring-blue-300 font-medium rounded-lg text-sm px-5 py-2.5 text-center inline-flex items-center"
            >
              {trigger.isLoading ? (
                <>
                  <svg
                    className="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  Submitting...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4 mr-2" />
                  Submit Batch
                </>
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
