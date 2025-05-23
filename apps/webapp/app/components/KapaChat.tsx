import { ArrowUpIcon } from "@heroicons/react/24/solid";
import { KapaProvider, useChat } from "@kapaai/react-sdk";
import { useSearchParams } from "@remix-run/react";
import { motion } from "framer-motion";
import { marked } from "marked";
import { useCallback, useEffect, useRef, useState } from "react";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { SparkleListIcon } from "~/assets/icons/SparkleListIcon";
import { Button } from "./primitives/Buttons";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./primitives/Dialog";
import { Header2 } from "./primitives/Headers";
import { Paragraph } from "./primitives/Paragraph";
import { Spinner } from "./primitives/Spinner";

type KapaChatProps = {
  websiteId: string;
  onOpen?: () => void;
  onClose?: () => void;
};

function ChatMessages({
  conversation,
  isPreparingAnswer,
  isGeneratingAnswer,
  onReset,
  onExampleClick,
}: {
  conversation: any[];
  isPreparingAnswer: boolean;
  isGeneratingAnswer: boolean;
  onReset: () => void;
  onExampleClick: (question: string) => void;
}) {
  const exampleQuestions = [
    "How do I handle errors in my task?",
    "What are the different types of triggers?",
    "How do I deploy my tasks?",
  ];

  return (
    <div className="flex-1 overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
      {conversation.length === 0 ? (
        <motion.div
          className="flex flex-col gap-2"
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
              dangerouslySetInnerHTML={{ __html: marked(qa.answer) }}
            />
          </div>
        ))
      )}
      {isPreparingAnswer && (
        <div className="flex items-center gap-2">
          <Spinner className="size-4" />
          <Paragraph className="text-text-dimmed">Preparing answer…</Paragraph>
        </div>
      )}
      {isGeneratingAnswer && (
        <div className="flex items-center gap-2">
          <Spinner className="size-4" />
          <Paragraph className="text-text-dimmed">Generating answer…</Paragraph>
          <Button variant="tertiary/small" onClick={onReset}>
            Reset
          </Button>
        </div>
      )}
    </div>
  );
}

function ChatInterface({ initialQuery }: { initialQuery?: string }) {
  const [message, setMessage] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const hasSubmittedInitialQuery = useRef(false);
  const { conversation, submitQuery, isGeneratingAnswer, isPreparingAnswer, resetConversation } =
    useChat();

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

  return (
    <motion.div
      className="flex h-full max-h-[90vh] grow flex-col overflow-y-auto bg-background-bright"
      animate={{ height: isExpanded ? "90vh" : "auto" }}
      transition={{ type: "spring", damping: 25, stiffness: 300 }}
      initial={{ height: "auto" }}
    >
      <ChatMessages
        conversation={conversation}
        isPreparingAnswer={isPreparingAnswer}
        isGeneratingAnswer={isGeneratingAnswer}
        onReset={resetConversation}
        onExampleClick={handleExampleClick}
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
            className="flex-1 rounded-md border border-grid-bright bg-background-dimmed px-3 py-2 text-text-bright placeholder:text-text-dimmed focus:border-indigo-500 focus:outline-none"
          />
          <Button
            type="submit"
            disabled={!message.trim()}
            LeadingIcon={<ArrowUpIcon className="size-5 text-text-bright" />}
            variant="primary/large"
            className="rounded-full"
          />
        </div>
      </form>
    </motion.div>
  );
}

export function KapaChat({ websiteId, onOpen }: KapaChatProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState<string | undefined>();
  const [searchParams, setSearchParams] = useSearchParams();

  const handleOpen = useCallback(() => {
    setIsOpen(true);
    onOpen?.();
  }, [onOpen]);

  // Handle URL param functionality
  useEffect(() => {
    const aiHelp = searchParams.get("aiHelp");
    if (aiHelp) {
      setSearchParams((prev) => {
        prev.delete("aiHelp");
        return prev;
      });

      const decodedAiHelp = decodeURIComponent(aiHelp);
      setInitialQuery(decodedAiHelp);
      handleOpen();
    }
  }, [searchParams, setSearchParams, handleOpen]);

  if (!websiteId) return null;

  return (
    <KapaProvider
      integrationId={websiteId}
      callbacks={{
        askAI: {
          onQuerySubmit: () => handleOpen(),
          onAnswerGenerationCompleted: () => handleOpen(),
        },
      }}
      botProtectionMechanism="recaptcha"
    >
      <div className="relative">
        <Button
          variant="small-menu-item"
          data-action="ask-ai"
          shortcut={{ modifiers: ["mod"], key: "/", enabledOnInputElements: true }}
          hideShortcutKey
          data-modal-override-open-class-ask-ai="true"
          onClick={handleOpen}
        >
          <AISparkleIcon className="size-5" />
        </Button>

        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogContent className="flex !max-h-[90vh] min-h-fit w-full flex-col justify-between px-0 pb-0 pt-2.5 sm:max-w-prose">
            <DialogHeader className="pl-3">
              <div className="flex items-center gap-1">
                <AISparkleIcon className="size-5" />
                <DialogTitle className="text-sm font-medium text-text-bright">Ask AI</DialogTitle>
              </div>
            </DialogHeader>
            <ChatInterface initialQuery={initialQuery} />
          </DialogContent>
        </Dialog>
      </div>
    </KapaProvider>
  );
}
