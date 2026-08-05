import { ChatBubbleLeftRightIcon } from "@heroicons/react/20/solid";

/**
 * The agent's name and icon, in one place, so every entry point reads as the
 * same thing.
 *
 * TODO(TRI-12763): swap in the final character icon and product name here.
 */
export const AGENT_NAME = "Agent";

/** The label every entry point outside the panel uses. */
export const ASK_AGENT_LABEL = `Ask ${AGENT_NAME}`;

export const AgentIcon = ChatBubbleLeftRightIcon;

/** The accent the icon carries when the surrounding button isn't itself accented. */
export const AGENT_ICON_ACCENT_CLASS = "text-indigo-500";

// The keystroke that opens the agent is `TOGGLE_PANEL_SHORTCUT` in
// `dashboardAgentLauncher`, registered once by the host. Read it from there.
