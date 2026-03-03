"use server";

import { chat } from "@trigger.dev/sdk/ai";
import type { aiChat } from "@/trigger/chat";

export const getChatToken = async () => chat.createAccessToken<typeof aiChat>("ai-chat");
