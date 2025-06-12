import {
  ArrowPathIcon,
  ArrowUpIcon,
  HandThumbDownIcon,
  HandThumbUpIcon,
  StopIcon,
} from "@heroicons/react/20/solid";
import { type FeedbackComment, KapaProvider, type QA, useChat } from "@kapaai/react-sdk";
import { useSearchParams } from "@remix-run/react";
import DOMPurify from "dompurify";
import { motion } from "framer-motion";
import { marked } from "marked";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTypedRouteLoaderData } from "remix-typedjson";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { SparkleListIcon } from "~/assets/icons/SparkleListIcon";
import { useFeatures } from "~/hooks/useFeatures";
import { type loader } from "~/root";
import { Button } from "./primitives/Buttons";
import { Callout } from "./primitives/Callout";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./primitives/Dialog";
import { Header2 } from "./primitives/Headers";
import { Paragraph } from "./primitives/Paragraph";
import { ShortcutKey } from "./primitives/ShortcutKey";
import { Spinner } from "./primitives/Spinner";
import {
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./primitives/Tooltip";
import { ClientOnly } from "remix-utils/client-only";

function useKapaWebsiteId() {
  const routeMatch = useTypedRouteLoaderData<typeof loader>("root");
  return routeMatch?.kapa.websiteId;
}

export function AskAI() {
  const { isManagedCloud } = useFeatures();
  const websiteId = useKapaWebsiteId();

  if (!isManagedCloud || !websiteId) {
    return null;
  }

  return (
    <ClientOnly
      fallback={
        <Button
          variant="small-menu-item"
          data-action="ask-ai"
          hideShortcutKey
          data-modal-override-open-class-ask-ai="true"
          disabled
        >
          <AISparkleIcon className="size-5" />
        </Button>
      }
    >
      {() => <AskAIProvider websiteId={websiteId} />}
    </ClientOnly>
  );
}

type AskAIProviderProps = {
  websiteId: string;
};

function AskAIProvider({ websiteId }: AskAIProviderProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState<string | undefined>();
  const [searchParams, setSearchParams] = useSearchParams();

  const openAskAI = useCallback((question?: string) => {
    if (question) {
      setInitialQuery(question);
    } else {
      setInitialQuery(undefined);
    }
    setIsOpen(true);
  }, []);

  const closeAskAI = useCallback(() => {
    setIsOpen(false);
    setInitialQuery(undefined);
  }, []);

  // Handle URL param functionality
  useEffect(() => {
    const aiHelp = searchParams.get("aiHelp");
    if (aiHelp) {
      // Delay to avoid hCaptcha bot detection
      window.setTimeout(() => openAskAI(aiHelp), 1000);

      // Clone instead of mutating in place
      const next = new URLSearchParams(searchParams);
      next.delete("aiHelp");
      setSearchParams(next);
    }
  }, [searchParams, openAskAI]);

  return (
    <KapaProvider
      integrationId={websiteId}
      callbacks={{
        askAI: {
          onQuerySubmit: () => openAskAI(),
          onAnswerGenerationCompleted: () => openAskAI(),
        },
      }}
      botProtectionMechanism="hcaptcha"
    >
      <TooltipProvider disableHoverableContent>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="inline-flex">
              <Button
                variant="small-menu-item"
                data-action="ask-ai"
                shortcut={{ modifiers: ["mod"], key: "/", enabledOnInputElements: true }}
                hideShortcutKey
                data-modal-override-open-class-ask-ai="true"
                onClick={() => openAskAI()}
              >
                <AISparkleIcon className="size-5" />
              </Button>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="flex items-center gap-1 py-1.5 pl-2.5 pr-2 text-xs">
            Ask AI
            <ShortcutKey shortcut={{ modifiers: ["mod"], key: "/" }} variant="medium/bright" />
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <AskAIDialog
        initialQuery={initialQuery}
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        closeAskAI={closeAskAI}
      />
    </KapaProvider>
  );
}

type AskAIDialogProps = {
  initialQuery?: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  closeAskAI: () => void;
};

function AskAIDialog({ initialQuery, isOpen, onOpenChange, closeAskAI }: AskAIDialogProps) {
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      closeAskAI();
    } else {
      onOpenChange(open);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="animated-gradient-glow flex max-h-[90vh] min-h-fit w-full flex-col justify-between gap-0 px-0 pb-0 pt-0 sm:max-w-prose">
        <DialogHeader className="flex h-[2.75rem] items-start justify-center rounded-t-md bg-background-bright pl-3">
          <div className="flex items-center gap-1">
            <AISparkleIcon className="size-5" />
            <DialogTitle className="text-sm font-medium text-text-bright">Ask AI</DialogTitle>
          </div>
        </DialogHeader>
        <ChatInterface initialQuery={initialQuery} />
      </DialogContent>
    </Dialog>
  );
}

function ChatMessages({
  conversation,
  isPreparingAnswer,
  isGeneratingAnswer,
  onReset,
  onExampleClick,
  error,
  addFeedback,
}: {
  conversation: QA[];
  isPreparingAnswer: boolean;
  isGeneratingAnswer: boolean;
  onReset: () => void;
  onExampleClick: (question: string) => void;
  error: string | null;
  addFeedback: (
    questionAnswerId: string,
    reaction: "upvote" | "downvote",
    comment?: FeedbackComment
  ) => void;
}) {
  const [feedbackGivenForQAs, setFeedbackGivenForQAs] = useState<Set<string>>(new Set());

  // Reset feedback state when conversation is reset
  useEffect(() => {
    if (conversation.length === 0) {
      setFeedbackGivenForQAs(new Set());
    }
  }, [conversation.length]);

  // Check if feedback has been given for the latest QA
  const latestQA = conversation[conversation.length - 1];
  const hasFeedbackForLatestQA = latestQA?.id ? feedbackGivenForQAs.has(latestQA.id) : false;

  const exampleQuestions = [
    "How do I increase my concurrency limit?",
    "How do I debug errors in my task?",
    "How do I deploy my task?",
  ];

  return (
    <div className="flex-1 overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
      {conversation.length === 0 ? (
        <motion.div
          className="flex flex-col gap-2 pb-2"
          initial="hidden"
          animate="visible"
          variants={{
            hidden: { opacity: 0 },
            visible: {
              opacity: 1,
              transition: {
                staggerChildren: 0.1,
                delayChildren: 0.2,
              },
            },
          }}
        >
          <Paragraph className="mb-3 mt-1.5 pl-1">
            I'm trained on docs, examples, and other content. Ask me anything about Trigger.dev.
          </Paragraph>
          {exampleQuestions.map((question, index) => (
            <motion.button
              key={index}
              className="group flex w-fit items-center gap-2 rounded-full border border-dashed border-charcoal-600 px-4 py-2 transition-colors hover:border-solid hover:border-indigo-500"
              onClick={() => onExampleClick(question)}
              variants={{
                hidden: {
                  opacity: 0,
                  x: 20,
                },
                visible: {
                  opacity: 1,
                  x: 0,
                  transition: {
                    opacity: {
                      duration: 0.5,
                      ease: "linear",
                    },
                    x: {
                      type: "spring",
                      stiffness: 300,
                      damping: 25,
                    },
                  },
                },
              }}
            >
              <SparkleListIcon className="size-4 text-text-dimmed transition group-hover:text-indigo-500" />
              <Paragraph variant="small" className="transition group-hover:text-text-bright">
                {question}
              </Paragraph>
            </motion.button>
          ))}
        </motion.div>
      ) : (
        conversation.map((qa) => (
          <div key={qa.id || `temp-${qa.question}`} className="mb-4">
            <Header2 spacing>{qa.question}</Header2>
            <div
              className="prose prose-invert max-w-none text-text-dimmed"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked(qa.answer)) }}
            />
          </div>
        ))
      )}
      {conversation.length > 0 &&
        !isPreparingAnswer &&
        !isGeneratingAnswer &&
        !error &&
        !latestQA?.id && (
          <div className="flex items-center justify-between border-t border-grid-bright pt-3">
            <Paragraph variant="small" className="text-text-dimmed">
              Answer generation was stopped
            </Paragraph>
            <Button
              variant="minimal/small"
              LeadingIcon={<ArrowPathIcon className="size-4" />}
              onClick={onReset}
              className="w-fit pl-1.5"
              iconSpacing="gap-x-1.5"
            >
              Reset chat
            </Button>
          </div>
        )}
      {conversation.length > 0 &&
        !isPreparingAnswer &&
        !isGeneratingAnswer &&
        !error &&
        latestQA?.id && (
          <div className="flex items-center justify-between border-t border-grid-bright pt-3">
            {hasFeedbackForLatestQA ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3 }}
              >
                <Paragraph variant="small" className="text-text-dimmed">
                  Thanks for your feedback!
                </Paragraph>
              </motion.div>
            ) : (
              <div className="flex items-center gap-2">
                <Paragraph variant="small" className="text-text-dimmed">
                  Was this helpful?
                </Paragraph>
                <div className="flex items-center">
                  <Button
                    variant="minimal/small"
                    onClick={() => {
                      const latestQA = conversation[conversation.length - 1];
                      if (latestQA?.id) {
                        addFeedback(latestQA.id, "upvote");
                        setFeedbackGivenForQAs((prev) => new Set(prev).add(latestQA.id));
                      }
                    }}
                    className="size-8 px-1.5"
                  >
                    <HandThumbUpIcon className="size-4 text-text-dimmed transition group-hover/button:text-success" />
                  </Button>
                  <Button
                    variant="minimal/small"
                    onClick={() => {
                      const latestQA = conversation[conversation.length - 1];
                      if (latestQA?.id) {
                        addFeedback(latestQA.id, "downvote");
                        setFeedbackGivenForQAs((prev) => new Set(prev).add(latestQA.id));
                      }
                    }}
                    className="size-8 px-1.5"
                  >
                    <HandThumbDownIcon className="size-4 text-text-dimmed transition group-hover/button:text-error" />
                  </Button>
                </div>
              </div>
            )}
            <Button
              variant="minimal/small"
              LeadingIcon={<ArrowPathIcon className="size-4" />}
              onClick={onReset}
              className="w-fit pl-1.5"
              iconSpacing="gap-x-1.5"
            >
              Reset chat
            </Button>
          </div>
        )}
      {isPreparingAnswer && (
        <div className="flex items-center gap-2">
          <Spinner
            color={{
              background: "rgba(99, 102, 241, 1)",
              foreground: "rgba(217, 70, 239, 1)",
            }}
            className="size-4"
          />
          <Paragraph className="text-text-dimmed">Preparing answer…</Paragraph>
        </div>
      )}
      {error && (
        <div className="flex flex-col">
          <Callout variant="error" className="mb-4">
            <Paragraph className="font-semibold text-error">Error generating answer:</Paragraph>
            <Paragraph className="text-rose-300">
              {error} If the problem persists after retrying, please contact support.
            </Paragraph>
          </Callout>
          <div className="flex justify-end">
            <Button
              variant="secondary/small"
              LeadingIcon={<ArrowPathIcon className="size-4" />}
              onClick={onReset}
              className="w-fit pl-1.5"
              iconSpacing="gap-x-1.5"
            >
              Reset chat
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ChatInterface({ initialQuery }: { initialQuery?: string }) {
  const [message, setMessage] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const hasSubmittedInitialQuery = useRef(false);
  const {
    conversation,
    submitQuery,
    isGeneratingAnswer,
    isPreparingAnswer,
    resetConversation,
    stopGeneration,
    error,
    addFeedback,
  } = useChat();

  useEffect(() => {
    if (initialQuery && !hasSubmittedInitialQuery.current) {
      hasSubmittedInitialQuery.current = true;
      setIsExpanded(true);
      submitQuery(initialQuery);
    }
  }, [initialQuery, submitQuery]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim()) {
      setIsExpanded(true);
      submitQuery(message);
      setMessage("");
    }
  };

  const handleExampleClick = (question: string) => {
    setIsExpanded(true);
    submitQuery(question);
  };

  const handleReset = () => {
    resetConversation();
    setIsExpanded(false);
  };

  return (
    <motion.div
      className="flex h-full max-h-[90vh] grow flex-col overflow-y-auto rounded-b-md bg-background-bright"
      animate={{ height: isExpanded ? "90vh" : "auto" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      initial={{ height: "auto" }}
    >
      <ChatMessages
        conversation={conversation}
        isPreparingAnswer={isPreparingAnswer}
        isGeneratingAnswer={isGeneratingAnswer}
        onReset={handleReset}
        onExampleClick={handleExampleClick}
        error={error}
        addFeedback={addFeedback}
      />
      <form onSubmit={handleSubmit} className="flex-shrink-0 border-t border-grid-bright p-4">
        <div className="flex gap-3">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Ask a question..."
            disabled={isGeneratingAnswer}
            autoFocus
            className="flex-1 rounded-md border border-grid-bright bg-background-dimmed px-3 py-2 text-text-bright placeholder:text-text-dimmed focus-visible:focus-custom"
          />
          {isGeneratingAnswer ? (
            <SimpleTooltip
              button={
                <span
                  onClick={() => stopGeneration()}
                  className="group relative z-10 flex size-10 min-w-10 cursor-pointer items-center justify-center"
                >
                  <StopIcon className="z-10 size-5 text-indigo-500 transition group-hover:text-indigo-400" />
                  <GradientSpinnerBackground
                    className="absolute inset-0 animate-spin"
                    hoverEffect
                  />
                </span>
              }
              content="Stop generating"
            />
          ) : isPreparingAnswer ? (
            <GradientSpinnerBackground className="flex size-10 min-w-10 items-center justify-center">
              <Spinner
                color={{
                  background: "rgba(99, 102, 241, 1)",
                  foreground: "rgba(217, 70, 239, 1)",
                }}
                className="size-5"
              />
            </GradientSpinnerBackground>
          ) : (
            <Button
              type="submit"
              disabled={!message.trim()}
              LeadingIcon={<ArrowUpIcon className="size-5 text-text-bright" />}
              variant="primary/large"
              className="size-10 min-w-10 rounded-full group-disabled/button:border-charcoal-550 group-disabled/button:bg-charcoal-600"
            />
          )}
        </div>
      </form>
    </motion.div>
  );
}

function GradientSpinnerBackground({
  children,
  className,
  hoverEffect = false,
}: {
  children?: React.ReactNode;
  className?: string;
  hoverEffect?: boolean;
}) {
  return (
    <div
      className={`flex rounded-full bg-gradient-to-br from-indigo-500 via-purple-500 to-fuchsia-500 p-px ${className}`}
    >
      <div
        className={`flex h-full w-full items-center justify-center rounded-full bg-charcoal-600 ${
          hoverEffect ? "transition group-hover:bg-charcoal-550" : ""
        }`}
      >
        {children}
      </div>
    </div>
  );
}
