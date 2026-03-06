import { CheckIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { AnimatePresence, motion } from "framer-motion";
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { SparkleListIcon } from "~/assets/icons/SparkleListIcon";
import { Button } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";

const StreamdownRenderer = lazy(() =>
  import("streamdown").then((mod) => ({
    default: ({ children, isAnimating }: { children: string; isAnimating: boolean }) => (
      <mod.ShikiThemeContext.Provider value={["one-dark-pro", "one-dark-pro"]}>
        <mod.Streamdown isAnimating={isAnimating}>{children}</mod.Streamdown>
      </mod.ShikiThemeContext.Provider>
    ),
  }))
);

type StreamEventType =
  | { type: "thinking"; content: string }
  | { type: "result"; success: true; payload: string }
  | { type: "result"; success: false; error: string };

export function AIPayloadTabContent({
  onPayloadGenerated,
  payloadSchema,
  taskIdentifier,
  getCurrentPayload,
}: {
  onPayloadGenerated: (payload: string) => void;
  payloadSchema?: unknown;
  taskIdentifier: string;
  getCurrentPayload?: () => string;
}) {
  const [prompt, setPrompt] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [thinking, setThinking] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showThinking, setShowThinking] = useState(false);
  const [lastResult, setLastResult] = useState<"success" | "error" | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const resourcePath = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/test/ai-generate-payload`;

  const submitGeneration = useCallback(
    async (queryPrompt: string) => {
      if (!queryPrompt.trim() || isLoading) return;

      setIsLoading(true);
      setThinking("");
      setError(null);
      setShowThinking(true);
      setLastResult(null);

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = new AbortController();

      try {
        const formData = new FormData();
        formData.append("prompt", queryPrompt);
        formData.append("taskIdentifier", taskIdentifier);
        if (payloadSchema) {
          formData.append("payloadSchema", JSON.stringify(payloadSchema));
        }
        const currentPayload = getCurrentPayload?.();
        if (currentPayload) {
          formData.append("currentPayload", currentPayload);
        }

        const response = await fetch(resourcePath, {
          method: "POST",
          body: formData,
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          const errorData = (await response.json()) as { error?: string };
          setError(errorData.error || "Failed to generate payload");
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

          const lines = buffer.split("\n\n");
          buffer = lines.pop() || "";

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

        if (buffer.startsWith("data: ")) {
          try {
            const event = JSON.parse(buffer.slice(6)) as StreamEventType;
            processStreamEvent(event);
          } catch {
            // Ignore parse errors
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "An error occurred");
        setLastResult("error");
      } finally {
        setIsLoading(false);
      }
    },
    [isLoading, resourcePath, taskIdentifier, payloadSchema, getCurrentPayload]
  );

  const processStreamEvent = useCallback(
    (event: StreamEventType) => {
      switch (event.type) {
        case "thinking":
          setThinking((prev) => prev + event.content);
          break;
        case "result":
          if (event.success) {
            onPayloadGenerated(event.payload);
            setPrompt("");
            setLastResult("success");
          } else {
            setError(event.error);
            setLastResult("error");
          }
          break;
      }
    },
    [onPayloadGenerated]
  );

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      submitGeneration(prompt);
    },
    [prompt, submitGeneration]
  );

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 15000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  const examplePrompts = payloadSchema
    ? [
        "Generate a valid payload",
        "Generate a payload with edge cases",
        "Generate a minimal payload with only required fields",
      ]
    : [
        "Generate a simple JSON payload",
        "Generate a payload with nested objects",
        "Generate a payload with an array of items",
      ];

  return (
    <div className="space-y-2">
      <div
        className="overflow-hidden rounded-md p-px"
        style={{ background: "linear-gradient(to bottom right, #E543FF, #286399)" }}
      >
        <div className="overflow-hidden rounded-md bg-background-bright">
          <div>
            <textarea
              ref={textareaRef}
              name="prompt"
              placeholder={
                payloadSchema
                  ? "e.g. generate a payload for a new user signup"
                  : "e.g. generate a JSON payload with name, email, and age fields"
              }
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={isLoading}
              rows={5}
              className="m-0 min-h-10 w-full resize-none border-0 bg-background-bright px-3 py-2.5 text-sm text-text-bright scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600 placeholder:text-text-dimmed focus:border-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && prompt.trim() && !isLoading) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
            <div className="flex justify-end gap-2 px-2 pb-2">
              {isLoading ? (
                <Button
                  type="button"
                  variant="tertiary/small"
                  disabled={true}
                  LeadingIcon={Spinner}
                  className="pl-2"
                  iconSpacing="gap-1.5"
                >
                  Generating…
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="tertiary/small"
                  disabled={!prompt.trim()}
                  className={cn(!prompt.trim() && "opacity-50")}
                  onClick={() => handleSubmit()}
                >
                  Generate payload
                </Button>
              )}
            </div>
          </div>
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

      {/* Thinking panel */}
      <AnimatePresence>
        {showThinking && thinking && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-1">
              <div className="rounded-b-lg border-x border-b border-grid-dimmed bg-charcoal-850 p-3 pb-1">
                <div className="mb-1 flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    {isLoading ? (
                      <Spinner className="size-4" />
                    ) : lastResult === "success" ? (
                      <CheckIcon className="size-4 text-success" />
                    ) : lastResult === "error" ? (
                      <XMarkIcon className="size-4 text-error" />
                    ) : null}
                    <span className="text-xs font-medium text-text-dimmed">
                      {isLoading
                        ? "AI is thinking…"
                        : lastResult === "success"
                          ? "Payload generated"
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
                <div className="streamdown-container max-h-96 overflow-y-auto text-xs text-text-dimmed scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
                  <Suspense fallback={<p className="whitespace-pre-wrap">{thinking}</p>}>
                    <StreamdownRenderer isAnimating={isLoading}>{thinking}</StreamdownRenderer>
                  </Suspense>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Example prompts */}
      <div className="pt-4">
        <Header3 className="mb-3 text-text-bright">Example prompts</Header3>
        <div className="flex flex-wrap gap-2">
          {examplePrompts.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setPrompt(example);
                submitGeneration(example);
              }}
              className="group flex w-fit items-center gap-2 rounded-full border border-dashed border-charcoal-600 px-4 py-2 transition-colors hover:border-solid hover:border-indigo-500 focus-custom focus-visible:!rounded-full"
            >
              <SparkleListIcon className="size-4 shrink-0 text-text-dimmed transition group-hover:text-indigo-500" />
              <Paragraph
                variant="small"
                className="text-left transition group-hover:text-text-bright"
              >
                {example}
              </Paragraph>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
