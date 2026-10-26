import { EditPencilIcon } from "~/assets/icons/EditPencilIcon";
import { PlusIcon } from "~/assets/icons/PlusIcon";
import { AgentIcon } from "~/components/dashboard-agent/agent-identity";
import { NEW_CHAT_SHORTCUT } from "~/components/dashboard-agent/DashboardAgentHeader";
import { Button } from "~/components/primitives/Buttons";
import {
  SegmentedToggle,
  type SegmentedToggleSegment,
} from "~/components/primitives/SegmentedToggle";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";

export function NewChatButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="minimal/small"
      className="mr-[6px] aspect-square h-6 shrink-0 p-1"
      aria-label="New chat"
      tooltip={
        <span className="flex items-center">
          New chat
          <ShortcutKey shortcut={NEW_CHAT_SHORTCUT} variant="medium" />
        </span>
      }
      onClick={onClick}
      LeadingIcon={<PlusIcon className="size-4 text-text-dimmed" />}
    />
  );
}

const SEGMENTS: SegmentedToggleSegment<"agent" | "manual">[] = [
  {
    value: "agent",
    label: "Agent",
    ariaLabel: "Agent — Set with agent",
    icon: <AgentIcon className="size-3" />,
  },
  {
    value: "manual",
    label: "Manual",
    ariaLabel: "Manual — Set manually",
    icon: <EditPencilIcon className="size-3 text-text-dimmed" />,
  },
];

export function AgentManualToggle({
  manual,
  onChange,
}: {
  manual: boolean;
  onChange: (manual: boolean) => void;
}) {
  return (
    <SegmentedToggle
      segments={SEGMENTS}
      value={manual ? "manual" : "agent"}
      onChange={(value) => onChange(value === "manual")}
      ariaLabel={`${manual ? "Manual" : "Agent"} — change how this alert is built`}
    />
  );
}
