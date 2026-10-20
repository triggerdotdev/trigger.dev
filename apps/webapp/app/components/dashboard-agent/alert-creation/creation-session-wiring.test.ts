import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync(new URL("../DashboardAgentPanel.tsx", import.meta.url), "utf8");

describe("creation-session panel wiring", () => {
  it("uses useCreationSession hook (not inline effects)", () => {
    expect(panel).toContain("useCreationSession(");
  });

  it("passes create-session intent to the fetch", () => {
    expect(panel).toContain('"create-session"');
  });

  it("passes delete intent for discard", () => {
    expect(panel).toContain('"delete"');
    expect(panel).toContain("discardSession");
  });

  // Mutation: an ensure() outside alert creation brings the eager empty chats back.
  it("ensures the creation chat only on a free-text send or when an alert is created", () => {
    expect(panel.match(/creationSession\.ensure\(\)/g)).toHaveLength(2);
    const create = panel.slice(panel.indexOf("const handleAlertCreated = useCallback"));
    const body = create.slice(0, create.indexOf("const creationFlow = useCreationFlowState"));
    expect(body).toMatch(/const transcriptChatId =[\s\S]{0,300}creationSession\.ensure\(\)/);
  });

  // Mutation: resetting manualMode in restartCreation sends Start over back to Agent.
  it("Start over keeps the current creation mode", () => {
    const restart = panel.slice(panel.indexOf("const restartCreation = useCallback"));
    const body = restart.slice(0, restart.indexOf("}, ["));
    expect(body).toContain("setCreationMode(true)");
    expect(body).not.toContain("setManualMode");
  });

  it("New chat posts nothing", () => {
    const newChat = panel.slice(panel.indexOf("const newChat = useCallback"));
    const body = newChat.slice(0, newChat.indexOf("}, ["));
    expect(body).not.toMatch(/fetch\(|createChat\(/);
  });

  it("calls creationSession.keep() after a successful alert creation", () => {
    expect(panel).toContain("creationSession.keep()");
  });

  it("passes creationChatId to the CreationTranscript", () => {
    expect(panel).toContain("creationChatId");
    expect(panel).toContain("chatId={creationChatId");
  });

  it("mounts DashboardAgentChat when active (promotion path)", () => {
    expect(panel).toMatch(/:\s*active\s*\?\s*\([\s\S]*?<DashboardAgentChat/);
  });

  it("suppresses DashboardAgentDraft in creation mode (mutation: removing guard shows placeholder)", () => {
    expect(panel).toContain("inCreationMode || inEditMode ? null");
    const draftBlock = panel.slice(panel.indexOf("DashboardAgentDraft"));
    expect(draftBlock).toBeDefined();
    expect(panel).not.toMatch(/inCreationMode[^?]*<DashboardAgentDraft/);
  });
});
