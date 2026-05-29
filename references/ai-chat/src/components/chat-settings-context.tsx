"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

type ChatSettings = {
  taskMode: string;
  setTaskMode: (mode: string) => void;
  idleTimeoutInSeconds: number;
  setIdleTimeoutInSeconds: (seconds: number) => void;
  /**
   * When true, first-turn messages are POSTed to `/api/chat`
   * (`chat.handover` route handler) instead of triggering the agent
   * directly. Subsequent turns bypass the endpoint regardless.
   */
  useHandover: boolean;
  setUseHandover: (on: boolean) => void;
};

const ChatSettingsContext = createContext<ChatSettings | null>(null);

export function ChatSettingsProvider({ children }: { children: ReactNode }) {
  const [taskMode, setTaskMode] = useState("ai-chat");
  const [idleTimeoutInSeconds, setIdleTimeoutInSeconds] = useState(60);
  const [useHandover, setUseHandover] = useState(false);

  const value: ChatSettings = {
    taskMode,
    setTaskMode,
    idleTimeoutInSeconds,
    setIdleTimeoutInSeconds,
    useHandover,
    setUseHandover,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Provider = ChatSettingsContext.Provider as any;

  return <Provider value={value}>{children}</Provider>;
}

export function useChatSettings() {
  const ctx = useContext(ChatSettingsContext);
  if (!ctx) throw new Error("useChatSettings must be used within ChatSettingsProvider");
  return ctx;
}
