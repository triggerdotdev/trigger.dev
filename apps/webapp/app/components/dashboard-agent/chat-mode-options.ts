import { ChatFloatingPanel } from "~/assets/icons/ChatFloatingPanel";
import { ChatFullScreen } from "~/assets/icons/ChatFullScreen";
import { ChatRightPanel } from "~/assets/icons/ChatRightPanel";
import type { ChatOpenMode } from "~/utils/dashboardPreferences";

/** Every display mode, in menu order: the panel header's menu and the account preference share it. */
export const CHAT_MODE_OPTIONS: {
  mode: ChatOpenMode;
  label: string;
  Icon: typeof ChatFloatingPanel;
}[] = [
  { mode: "floating", label: "Floating panel", Icon: ChatFloatingPanel },
  { mode: "rightPanel", label: "Right panel", Icon: ChatRightPanel },
  { mode: "fullscreen", label: "Full page", Icon: ChatFullScreen },
];
