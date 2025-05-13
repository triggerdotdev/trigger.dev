"use client";

import { Button } from "@/components/ui/button";
import type { STREAMS, openaiStreaming } from "@/trigger/ai";
import { useRealtimeTaskTriggerWithStreams } from "@trigger.dev/react-hooks";
import { useCallback, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Card, CardContent, CardFooter } from "./ui/card";

export default function TriggerButton({ accessToken }: { accessToken: string }) {
  const [isOpen, setIsOpen] = useState(false);

  const { submit, isLoading, run, streams } = useRealtimeTaskTriggerWithStreams<
    typeof openaiStreaming,
    STREAMS
  >("openai-streaming", {
    accessToken,
    baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL,
  });

  const openWeatherReport = useCallback(() => {
    setIsOpen(true);
    submit({
      model: "gpt-4o-mini",
      prompt:
        "Based on the temperature, will I need to wear extra clothes today in San Fransico? Please be detailed.",
    });
  }, []);

  console.log("run", run);
  console.log("streams", streams);

  const toolCall = streams.openai?.find(
    (stream) => stream.type === "tool-call" && stream.toolName === "getWeather"
  );
  const toolResult = streams.openai?.find((stream) => stream.type === "tool-result");
  const textDeltas = streams.openai?.filter((stream) => stream.type === "text-delta");

  const text = textDeltas?.map((delta) => delta.textDelta).join("");
  const weatherLocation = toolCall ? toolCall.args.location : undefined;
  const weather = toolResult ? toolResult.result.temperature : undefined;

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" onClick={openWeatherReport}>
          Open Weather Report
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px] md:max-w-[700px] lg:max-w-[900px]">
        <DialogHeader>
          <DialogTitle>{weatherLocation} Weather Report</DialogTitle>
          <DialogDescription>Live weather update and city conditions</DialogDescription>
        </DialogHeader>
        <Card className="w-full mt-4">
          <CardContent className="p-6">
            <div className="h-[60vh] overflow-y-auto">
              {weather ? (
                <p className="text-lg leading-relaxed">{text || "Preparing weather report..."}</p>
              ) : (
                <p className="text-lg">Fetching weather data...</p>
              )}
            </div>
          </CardContent>
          {weather && (
            <CardFooter className="bg-muted p-4">
              <p className="text-sm">
                <span className="font-semibold">Tool Call:</span> The current temperature in{" "}
                {weatherLocation} is {weather}.
              </p>
            </CardFooter>
          )}
        </Card>
      </DialogContent>
    </Dialog>
  );
}
