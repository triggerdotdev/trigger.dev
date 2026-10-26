import { useState } from "react";
import { ChatText, ChatTranscript, ChatTurn } from "~/components/dashboard-agent/chat-layout";
import { ChatWizardCard, type ChatWizardStep } from "~/components/dashboard-agent/ChatWizardCard";
import { useChatWizard } from "~/components/dashboard-agent/useChatWizard";
import { CreationComposer } from "~/components/alerts/CreationComposer";
import { Button } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { cn } from "~/utils/cn";
import { PANEL_FRAME } from "../storybook.agent-ui/gallery";

const flowSteps: ChatWizardStep[] = [
  {
    id: "area",
    question: "What should this alert watch?",
    options: [
      { id: "runs", label: "Failed runs" },
      { id: "queues", label: "Queue depth" },
      { id: "latency", label: "Run duration" },
    ],
  },
  {
    id: "scope",
    question: "Which tasks should it cover?",
    options: [
      { id: "all", label: "All tasks in this environment" },
      { id: "critical", label: "Only tasks tagged critical" },
      { id: "one", label: "Just send-invoice" },
    ],
  },
  {
    id: "channel",
    question: "Where should I send the alert?",
    options: [
      { id: "slack", label: "Slack #alerts" },
      { id: "email", label: "Email the team" },
      { id: "webhook", label: "Webhook" },
    ],
  },
];

const confirmSteps: ChatWizardStep[] = [
  {
    id: "confirm",
    question: "Create this alert now?",
    allowSkip: false,
    options: [
      { id: "yes", label: "Yes, create it" },
      { id: "no", label: "Not yet" },
    ],
  },
];

const variants = [
  { id: "flow", label: "3-step flow", steps: flowSteps },
  { id: "confirm", label: "No skip", steps: confirmSteps },
];

function WizardDemo({ steps }: { steps: ChatWizardStep[] }) {
  const wizard = useChatWizard(steps);
  const [draft, setDraft] = useState("");

  return (
    <div className="space-y-3">
      <div className={cn(PANEL_FRAME, "flex h-[520px] flex-col overflow-hidden")}>
        <ChatTranscript>
          <ChatTurn speaker="user">
            <ChatText speaker="user" text="Set up an alert for my production runs" />
          </ChatTurn>
          <ChatTurn>
            <ChatText text="Sure. A few quick questions so I set it up the way you want." />
          </ChatTurn>
        </ChatTranscript>
        <div className="relative">
          {wizard.open ? (
            <ChatWizardCard
              steps={steps}
              stepIndex={wizard.stepIndex}
              onStepChange={wizard.onStepChange}
              onSelect={wizard.onSelect}
              onSkip={wizard.onSkip}
              onClose={wizard.onClose}
              className="absolute inset-x-3 bottom-full mb-1"
            />
          ) : null}
          <CreationComposer
            value={draft}
            onChange={setDraft}
            onSubmit={() => setDraft("")}
            onStop={() => {}}
            isStreaming={false}
          />
        </div>
      </div>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          {steps
            .filter((step) => step.id in wizard.answers)
            .map((step) => {
              const answer = wizard.answers[step.id];
              const label = step.options.find((o) => o.id === answer)?.label ?? "skipped";
              return (
                <Paragraph key={step.id} variant="extra-small/dimmed">
                  {step.question} → {label}
                </Paragraph>
              );
            })}
        </div>
        <Button variant="secondary/small" onClick={wizard.reset}>
          Restart
        </Button>
      </div>
    </div>
  );
}

export function ChatWizardDemo() {
  const [variantId, setVariantId] = useState("flow");
  const variant = variants.find((v) => v.id === variantId) ?? variants[0];

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {variants.map((v) => (
          <Button
            key={v.id}
            variant={v.id === variantId ? "primary/small" : "secondary/small"}
            onClick={() => setVariantId(v.id)}
          >
            {v.label}
          </Button>
        ))}
      </div>
      <WizardDemo key={variant.id} steps={variant.steps} />
      <Paragraph variant="extra-small/dimmed">
        Keys: 1-9 pick, ←/→ step, ↑/↓ move, Enter confirms, Esc closes.
      </Paragraph>
    </div>
  );
}
