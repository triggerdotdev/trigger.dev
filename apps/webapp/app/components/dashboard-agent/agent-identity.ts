import { ChatBubbleLeftRightIcon } from "@heroicons/react/20/solid";

/**
 * The agent's name and face, in one place.
 *
 * Every surface that offers the agent — the header launcher, an Investigate
 * button on a page, the "Ask …" item in Help & Feedback — must read as the same
 * thing, so none of them picks its own icon or accent.
 *
 * TODO(TRI-12763): design is drawing a character icon and settling on the
 * agent's product name. Both drop in here and every surface follows; nothing
 * else needs touching.
 */
export const AGENT_NAME = "Agent";

/** "Ask Agent" — the label every entry point outside the panel uses. */
export const ASK_AGENT_LABEL = `Ask ${AGENT_NAME}`;

/** The agent's icon. See the TODO above. */
export const AgentIcon = ChatBubbleLeftRightIcon;

/** The accent the icon carries wherever the surrounding button isn't itself accented. */
export const AGENT_ICON_ACCENT_CLASS = "text-indigo-500";

// The keystroke that opens the agent is `TOGGLE_PANEL_SHORTCUT` in
// `dashboardAgentLauncher` — registered once, by the host. Entry points that
// show it read it from there rather than restating it here.
