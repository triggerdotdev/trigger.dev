"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

type ChatSettings = {
  taskMode: string;
  setTaskMode: (mode: string) => void;
  preloadEnabled: boolean;
  setPreloadEnabled: (enabled: boolean) => void;
  idleTimeoutInSeconds: number;
  setIdleTimeoutInSeconds: (seconds: number) => void;
};

const ChatSettingsContext = createContext<ChatSettings | null>(null);

export function ChatSettingsProvider({ children }: { children: ReactNode }) {
  const [taskMode, setTaskMode] = useState("ai-chat");
  const [preloadEnabled, setPreloadEnabled] = useState(true);
  const [idleTimeoutInSeconds, setIdleTimeoutInSeconds] = useState(60);

  const value: ChatSettings = {
    taskMode,
    setTaskMode,
    preloadEnabled,
    setPreloadEnabled,
    idleTimeoutInSeconds,
    setIdleTimeoutInSeconds,
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
