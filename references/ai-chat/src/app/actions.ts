"use server";

import { createChatAccessToken } from "@trigger.dev/sdk/ai";
import type { chat } from "@/trigger/chat";

export const getChatToken = async () => createChatAccessToken<typeof chat>("ai-chat");
