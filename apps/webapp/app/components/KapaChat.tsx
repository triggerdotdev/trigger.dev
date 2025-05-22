import { XMarkIcon } from "@heroicons/react/20/solid";
import { ArrowUpIcon } from "@heroicons/react/24/solid";
import { KapaProvider, useChat } from "@kapaai/react-sdk";
import { useSearchParams } from "@remix-run/react";
import { useCallback, useEffect, useState } from "react";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { Button } from "./primitives/Buttons";
import { Header2 } from "./primitives/Headers";
import { Paragraph } from "./primitives/Paragraph";
import { Spinner } from "./primitives/Spinner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./primitives/Dialog";

type KapaChatProps = {
  websiteId: string;
  onOpen?: () => void;
  onClose?: () => void;
};

function ChatInterface({ onOpen, onClose }: { onOpen?: () => void; onClose?: () => void }) {
  const [message, setMessage] = useState("");
  const { conversation, submitQuery, isGeneratingAnswer, isPreparingAnswer } = useChat();
  const [searchParams, setSearchParams] = useSearchParams();

  // Handle URL param functionality
  useEffect(() => {
    const aiHelp = searchParams.get("aiHelp");
    if (aiHelp) {
      setSearchParams((prev) => {
        prev.delete("aiHelp");
        return prev;
      });

      const decodedAiHelp = decodeURIComponent(aiHelp);
      submitQuery(decodedAiHelp);
    }
  }, [searchParams, setSearchParams, submitQuery]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim()) {
      submitQuery(message);
      setMessage("");
    }
  };

  return (
    <div className="flex h-full max-h-full grow flex-col overflow-y-auto bg-background-bright">
      <div className="flex-1 overflow-y-auto p-4">
        {conversation.map((qa) => (
          <div key={qa.id || `temp-${qa.question}`} className="mb-4">
            <div className="mb-2 font-medium text-text-bright">{qa.question}</div>
            <div className="text-text-dimmed">{qa.answer}</div>
          </div>
        ))}
        {isPreparingAnswer && (
          <div className="flex items-center gap-2">
            <Spinner className="size-4" />
            <Paragraph className="text-text-dimmed">Preparing answer…</Paragraph>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="flex-shrink-0 border-t border-grid-bright p-4">
        <div className="flex gap-2">
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
            disabled={isGeneratingAnswer || !message.trim()}
            LeadingIcon={<ArrowUpIcon className="size-5" />}
            variant="primary/large"
            className="rounded-full"
          />
        </div>
      </form>
    </div>
  );
}

export function KapaChat({ websiteId, onOpen, onClose }: KapaChatProps) {
  const [isOpen, setIsOpen] = useState(false);

  const handleOpen = useCallback(() => {
    setIsOpen(true);
    onOpen?.();
  }, [onOpen]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    onClose?.();
  }, [onClose]);

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
          <DialogContent className="flex max-h-[90vh] min-h-80 w-full flex-col justify-between px-0 pb-0 pt-2.5 sm:max-w-prose">
            <DialogHeader className="pl-3">
              <div className="flex items-center gap-1">
                <AISparkleIcon className="size-5" />
                <DialogTitle className="text-sm font-medium text-text-bright">Ask AI</DialogTitle>
              </div>
            </DialogHeader>
            <ChatInterface onOpen={handleOpen} onClose={handleClose} />
          </DialogContent>
        </Dialog>
      </div>
    </KapaProvider>
  );
}
