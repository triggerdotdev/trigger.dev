import { useState } from "react";
import { ChatWizardCard, type ChatWizardStep } from "~/components/dashboard-agent/ChatWizardCard";
import { noop } from "../storybook.agent-ui/gallery";
import { ChatWizardDemo } from "./chat-wizard-demo";

const numberParse = (min: number) => (text: string) => {
  const n = Number(text.trim());
  return text.trim() && Number.isFinite(n) && n >= min ? String(n) : undefined;
};

const inFuture = (text: string) => (Date.parse(text) > Date.now() ? text : undefined);

function StaticCard({ step }: { step: ChatWizardStep }) {
  return (
    <ChatWizardCard
      steps={[step]}
      stepIndex={0}
      onStepChange={noop}
      onSelect={noop}
      onSkip={noop}
      onClose={noop}
    />
  );
}

const optionInfoStep: ChatWizardStep = {
  id: "what",
  question: "What about queues?",
  allowSkip: false,
  selected: ["depth"],
  options: [
    {
      id: "depth",
      label: "Depth getting too high",
      description: "Counts runs waiting in the queue.",
    },
    {
      id: "age",
      label: "Oldest run waiting too long",
      description: "Measures how long the oldest queued run has waited.",
    },
    { id: "stalled", label: "A queue stalling" },
  ],
};

function EntityStory() {
  const [value, setValue] = useState<string>();
  return (
    <StaticCard
      step={{
        id: "scope",
        question: "Which queues should this alert cover?",
        allowSkip: false,
        selected: ["queue"],
        options: [
          { id: "all", label: "All queues" },
          { id: "queue", label: "Specific queue" },
        ],
        entity: {
          id: "queue",
          ariaLabel: "Queue",
          placeholder: "Select a queue",
          options: ["email-queue", "billing-queue"].map((name) => ({ id: name, label: name })),
          selected: value,
          onSelect: setValue,
        },
      }}
    />
  );
}

function CustomUnitStory() {
  const [value, setValue] = useState<string>();
  return (
    <StaticCard
      step={{
        id: "condition",
        question: "When should this alert fire?",
        description: "Fires when p95 scheduling delay gets longer than the threshold.",
        allowSkip: false,
        options: [
          { id: "1000", label: "1,000ms" },
          { id: "5000", label: "5,000ms" },
        ],
        custom: {
          id: "value",
          current: value,
          placeholder: "when p95 scheduling delay gets longer than…",
          ariaLabel: "Scheduling delay threshold",
          numeric: true,
          unit: "milliseconds",
          parse: numberParse(0),
          onSubmit: setValue,
        },
      }}
    />
  );
}

function MultiParamStory() {
  const [params, setParams] = useState<Record<string, string>>({ backlogCount: "500" });
  const complete = Boolean(params.backlogCount && params.schedulingDelayMs);
  const field = (key: string, label: string, unit: string, placeholder: string) => ({
    id: key,
    live: true,
    current: params[key],
    label: `${label} above`,
    unit,
    placeholder,
    ariaLabel: `${label} threshold`,
    numeric: true,
    parse: numberParse(1),
    onSubmit: (value: string) => setParams((prev) => ({ ...prev, [key]: value })),
  });
  return (
    <StaticCard
      step={{
        id: "condition",
        question: "When should this alert fire?",
        description: "Fires when flow health crosses any of these thresholds.",
        allowSkip: false,
        selected: complete ? ["continue"] : [],
        options: [
          {
            id: "continue",
            label: "Continue",
            disabledReason: complete ? undefined : "Set every threshold to continue",
          },
        ],
        fields: [
          field("schedulingDelayMs", "Scheduling delay p95", "milliseconds", "30000"),
          field("backlogCount", "Queued runs", "runs", "1000"),
        ],
      }}
    />
  );
}

const expiryOptions = [
  { id: "none", label: "No expiry" },
  { id: "7d", label: "7 days" },
  { id: "custom", label: "Until…" },
];

function UntilStory({ past = false }: { past?: boolean }) {
  const [current] = useState(() =>
    new Date(Date.now() + (past ? -1 : 7) * 24 * 60 * 60 * 1000).toISOString()
  );
  return (
    <StaticCard
      step={{
        id: "expiry",
        question: "How long should it stay active?",
        description: "The alert stops checking once it expires.",
        allowSkip: false,
        options: expiryOptions,
        selected: ["custom"],
        customOption: "custom",
        custom: {
          id: "expiry",
          type: "date",
          current,
          ariaLabel: "Expires at",
          parse: inFuture,
          onSubmit: noop,
        },
      }}
    />
  );
}

const errorStep: ChatWizardStep = {
  id: "condition",
  question: "When should this alert fire?",
  description: "Fires when queue depth gets higher than the threshold.",
  allowSkip: false,
  options: [
    { id: "50", label: "50" },
    { id: "100", label: "100" },
  ],
  custom: {
    id: "value",
    current: "-5",
    ariaLabel: "Queue depth threshold",
    numeric: true,
    rule: { min: 0 },
    unit: "runs",
    parse: numberParse(0),
    onSubmit: noop,
  },
};

export const WIZARD_STATES: Record<string, React.ReactNode> = {
  "wizard-card": <ChatWizardDemo />,
  "wizard-option-info": <StaticCard step={optionInfoStep} />,
  "wizard-entity": <EntityStory />,
  "wizard-custom-unit": <CustomUnitStory />,
  "wizard-multi-param": <MultiParamStory />,
  "wizard-until": <UntilStory />,
  "wizard-error": (
    <div className="flex flex-col gap-4">
      <StaticCard step={errorStep} />
      <UntilStory past />
    </div>
  ),
};
