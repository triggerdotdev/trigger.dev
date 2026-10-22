import { useState } from "react";
import type { ChatWizardStep } from "./ChatWizardCard";

export function useChatWizard(steps: ChatWizardStep[]) {
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string | null>>({});
  const [open, setOpen] = useState(true);

  const record = (stepId: string, answer: string | null) => {
    setAnswers((prev) => ({ ...prev, [stepId]: answer }));
    if (stepIndex < steps.length - 1) setStepIndex(stepIndex + 1);
    else setOpen(false);
  };

  return {
    open,
    answers,
    stepIndex,
    onStepChange: setStepIndex,
    onSelect: (stepId: string, optionId: string) => record(stepId, optionId),
    onSkip: (stepId: string) => record(stepId, null),
    onClose: () => setOpen(false),
    reset: () => {
      setStepIndex(0);
      setAnswers({});
      setOpen(true);
    },
  };
}
