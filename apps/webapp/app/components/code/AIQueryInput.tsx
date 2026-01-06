import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { Button } from "~/components/primitives/Buttons";
import { Spinner } from "~/components/primitives/Spinner";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";

type StreamEventType =
  | { type: "thinking"; content: string }
  | { type: "tool_call"; tool: string; args: unknown }
  | { type: "tool_result"; tool: string; result: unknown }
  | { type: "result"; success: true; query: string }
  | { type: "result"; success: false; error: string };

interface AIQueryInputProps {
  onQueryGenerated: (query: string) => void;
  /** Set this to a prompt to auto-populate and immediately submit */
  autoSubmitPrompt?: string;
}

export function AIQueryInput({ onQueryGenerated, autoSubmitPrompt }: AIQueryInputProps) {
  const [prompt, setPrompt] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [thinking, setThinking] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showThinking, setShowThinking] = useState(false);
  const [lastResult, setLastResult] = useState<"success" | "error" | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastAutoSubmitRef = useRef<string | null>(null);

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const resourcePath = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/query/ai-generate`;

  const submitQuery = useCallback(
    async (queryPrompt: string) => {
      if (!queryPrompt.trim() || isLoading) return;

      setIsLoading(true);
      setThinking("");
      setError(null);
      setShowThinking(true);
      setLastResult(null);

      // Abort any existing request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();

      try {
        const formData = new FormData();
        formData.append("prompt", queryPrompt);

        const response = await fetch(resourcePath, {
          method: "POST",
          body: formData,
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          const errorData = (await response.json()) as { error?: string };
          setError(errorData.error || "Failed to generate query");
          setIsLoading(false);
          setLastResult("error");
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          setError("No response stream");
          setIsLoading(false);
          setLastResult("error");
          return;
        }

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete events from buffer
          const lines = buffer.split("\n\n");
          buffer = lines.pop() || ""; // Keep incomplete line in buffer

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const event = JSON.parse(line.slice(6)) as StreamEventType;
                processStreamEvent(event);
              } catch {
                // Ignore parse errors
              }
            }
          }
        }

        // Process any remaining data
        if (buffer.startsWith("data: ")) {
          try {
            const event = JSON.parse(buffer.slice(6)) as StreamEventType;
            processStreamEvent(event);
          } catch {
            // Ignore parse errors
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          // Request was aborted, ignore
          return;
        }
        setError(err instanceof Error ? err.message : "An error occurred");
        setLastResult("error");
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading, resourcePath]
  );

  const processStreamEvent = useCallback(
    (event: StreamEventType) => {
      switch (event.type) {
        case "thinking":
          setThinking((prev) => prev + event.content);
          break;
        case "tool_call":
          setThinking((prev) => prev + `\n[Validating query...]\n`);
          break;
        case "tool_result":
          // Optionally show validation result
          break;
        case "result":
          if (event.success) {
            onQueryGenerated(event.query);
            setPrompt("");
            setLastResult("success");
            // Keep thinking visible to show what happened
          } else {
            setError(event.error);
            setLastResult("error");
          }
          break;
      }
    },
    [onQueryGenerated]
  );

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      submitQuery(prompt);
    },
    [prompt, submitQuery]
  );

  // Auto-submit when autoSubmitPrompt changes
  useEffect(() => {
    if (
      autoSubmitPrompt &&
      autoSubmitPrompt.trim() &&
      autoSubmitPrompt !== lastAutoSubmitRef.current &&
      !isLoading
    ) {
      lastAutoSubmitRef.current = autoSubmitPrompt;
      setPrompt(autoSubmitPrompt);
      submitQuery(autoSubmitPrompt);
    }
  }, [autoSubmitPrompt, isLoading, submitQuery]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Auto-hide error after delay
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 15000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  return (
    <div className="flex flex-col gap-3">
      {/* Gradient border wrapper like the schedules AI input */}
      <div
        className="rounded-md p-px"
        style={{ background: "linear-gradient(to bottom right, #E543FF, #286399)" }}
      >
        <div className="overflow-hidden rounded-[5px] bg-background-bright">
          <form onSubmit={handleSubmit}>
            <textarea
              ref={textareaRef}
              name="prompt"
              placeholder="e.g. show me failed runs from the last 7 days"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={isLoading}
              rows={8}
              className="m-0 min-h-10 w-full resize-none border-0 bg-background-bright px-3 py-2.5 text-sm text-text-bright scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600 file:border-0 file:bg-transparent file:text-base file:font-medium placeholder:text-text-dimmed focus:border-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && prompt.trim() && !isLoading) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
            <div className="flex justify-end gap-2 px-2 pb-2">
              <Button
                type="submit"
                variant="tertiary/small"
                disabled={isLoading || !prompt.trim()}
                LeadingIcon={isLoading ? Spinner : AISparkleIcon}
                className="pl-1.5"
                iconSpacing="gap-1.5"
              >
                {isLoading ? "Generating" : "Generate"}
              </Button>
            </div>
          </form>
        </div>
      </div>

      {/* Error message */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
              {error}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Thinking panel - stays visible after completion */}
      <AnimatePresence>
        {showThinking && thinking && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="rounded-md border border-grid-dimmed bg-charcoal-850 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {isLoading ? (
                    <Spinner
                      color={{
                        background: "rgba(99, 102, 241, 0.3)",
                        foreground: "rgba(99, 102, 241, 1)",
                      }}
                      className="size-3"
                    />
                  ) : lastResult === "success" ? (
                    <div className="size-3 rounded-full bg-success" />
                  ) : lastResult === "error" ? (
                    <div className="size-3 rounded-full bg-error" />
                  ) : null}
                  <span className="text-xs font-medium text-text-dimmed">
                    {isLoading
                      ? "AI is thinking..."
                      : lastResult === "success"
                      ? "Query generated"
                      : lastResult === "error"
                      ? "Generation failed"
                      : "AI response"}
                  </span>
                </div>
                {isLoading ? (
                  <Button
                    variant="minimal/small"
                    onClick={() => {
                      if (abortControllerRef.current) {
                        abortControllerRef.current.abort();
                      }
                      setIsLoading(false);
                      setShowThinking(false);
                      setThinking("");
                    }}
                    className="text-xs"
                  >
                    Cancel
                  </Button>
                ) : (
                  <Button
                    variant="minimal/small"
                    onClick={() => {
                      setShowThinking(false);
                      setThinking("");
                    }}
                    className="text-xs"
                  >
                    Dismiss
                  </Button>
                )}
              </div>
              <div className="max-h-48 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
                <p className="whitespace-pre-wrap text-xs text-text-dimmed">
                  {thinking.slice(-800)}
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
