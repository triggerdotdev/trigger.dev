// Import the test harness FIRST so the resource catalog is installed
import { mockChatAgent } from "../src/v3/test/index.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream, streamText } from "ai";
import { buildSkillTools, chat } from "../src/v3/ai.js";
import { defineSkill } from "../src/v3/skill.js";

function userMessage(text: string, id?: string) {
  return {
    id: id ?? `u-${Math.random().toString(36).slice(2)}`,
    role: "user" as const,
    parts: [{ type: "text" as const, text }],
  };
}

function textStream(text: string) {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
    },
  ];
  return simulateReadableStream({ chunks });
}

const originalCwd = process.cwd();
let workdir: string;

beforeEach(async () => {
  workdir = await realpath(await mkdtemp(path.join(tmpdir(), "skills-runtime-")));
  process.chdir(workdir);

  // Bundled skill layout
  const skillDir = path.join(workdir, ".trigger", "skills", "demo");
  await mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await mkdir(path.join(skillDir, "references"), { recursive: true });

  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: demo\ndescription: Demo skill for tests.\n---\n\n# Demo\n\nUse scripts/hello.sh to say hello.\n`
  );

  const scriptPath = path.join(skillDir, "scripts", "hello.sh");
  await writeFile(scriptPath, `#!/usr/bin/env bash\necho "hi from $1"\n`);
  await chmod(scriptPath, 0o755);

  await writeFile(path.join(skillDir, "references", "notes.txt"), "Reference note.\n");
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

describe("chat.skills runtime integration", () => {
  it("injects skills preamble into the system prompt", async () => {
    let capturedSystem: string | undefined;

    const model = new MockLanguageModelV3({
      doStream: async (opts) => {
        const system = opts.prompt.find((m) => m.role === "system");
        capturedSystem = system ? JSON.stringify(system.content) : undefined;
        return { stream: textStream("ok") };
      },
    });

    const skill = defineSkill({ id: "demo", path: "./skills/demo" });

    const agent = chat.agent({
      id: "skills-runtime.system-prompt",
      onChatStart: async () => {
        chat.skills.set([await skill.local()]);
      },
      run: async ({ messages, signal }) => {
        return streamText({
          model,
          messages,
          abortSignal: signal,
          ...chat.toStreamTextOptions(),
        });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "t1" });
    try {
      await harness.sendMessage(userMessage("hi"));
      await new Promise((r) => setTimeout(r, 20));
      expect(capturedSystem).toContain("Available skills");
      expect(capturedSystem).toContain("demo: Demo skill for tests");
    } finally {
      await harness.close();
    }
  });

  it("auto-wires loadSkill / readFile / bash tools", async () => {
    let capturedToolNames: string[] = [];

    const model = new MockLanguageModelV3({
      doStream: async (opts) => {
        capturedToolNames = (opts.tools ?? []).map((t) => t.name);
        return { stream: textStream("ok") };
      },
    });

    const skill = defineSkill({ id: "demo", path: "./skills/demo" });

    const agent = chat.agent({
      id: "skills-runtime.auto-tools",
      onChatStart: async () => {
        chat.skills.set([await skill.local()]);
      },
      run: async ({ messages, signal }) => {
        return streamText({
          model,
          messages,
          abortSignal: signal,
          ...chat.toStreamTextOptions(),
        });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "t2" });
    try {
      await harness.sendMessage(userMessage("hi"));
      await new Promise((r) => setTimeout(r, 20));
      expect(capturedToolNames).toEqual(expect.arrayContaining(["loadSkill", "readFile", "bash"]));
    } finally {
      await harness.close();
    }
  });
});

describe("buildSkillTools — direct execute", () => {
  it("loadSkill returns body + path for a known skill", async () => {
    const skill = defineSkill({ id: "demo", path: "./skills/demo" });
    const resolved = await skill.local();
    const tools = buildSkillTools([resolved]);

    const out = await (tools.loadSkill as any).execute({ name: "demo" });
    expect(out.name).toBe("demo");
    expect(out.body).toContain("# Demo");
    expect(out.path).toBe(resolved.path);
  });

  it("loadSkill returns an error for an unknown skill", async () => {
    const skill = defineSkill({ id: "demo", path: "./skills/demo" });
    const tools = buildSkillTools([await skill.local()]);

    const out = await (tools.loadSkill as any).execute({ name: "missing" });
    expect(out.error).toContain('Skill "missing" not found');
  });

  it("readFile reads a bundled reference", async () => {
    const skill = defineSkill({ id: "demo", path: "./skills/demo" });
    const tools = buildSkillTools([await skill.local()]);

    const out = await (tools.readFile as any).execute({
      skill: "demo",
      path: "references/notes.txt",
    });
    expect(out.content).toBe("Reference note.\n");
  });

  it("readFile rejects path traversal", async () => {
    const skill = defineSkill({ id: "demo", path: "./skills/demo" });
    const tools = buildSkillTools([await skill.local()]);

    const out = await (tools.readFile as any).execute({
      skill: "demo",
      path: "../../../../etc/passwd",
    });
    expect(out.error).toMatch(/escapes the skill directory/);
  });

  it("readFile rejects absolute paths", async () => {
    const skill = defineSkill({ id: "demo", path: "./skills/demo" });
    const tools = buildSkillTools([await skill.local()]);

    const out = await (tools.readFile as any).execute({
      skill: "demo",
      path: "/etc/passwd",
    });
    expect(out.error).toMatch(/must be relative/);
  });

  it("bash runs a bundled script and captures stdout", async () => {
    const skill = defineSkill({ id: "demo", path: "./skills/demo" });
    const tools = buildSkillTools([await skill.local()]);

    const out = await (tools.bash as any).execute({
      skill: "demo",
      command: "bash scripts/hello.sh world",
    });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("hi from world");
  });

  it("bash reports non-zero exit code", async () => {
    const skill = defineSkill({ id: "demo", path: "./skills/demo" });
    const tools = buildSkillTools([await skill.local()]);

    const out = await (tools.bash as any).execute({
      skill: "demo",
      command: "exit 7",
    });
    expect(out.exitCode).toBe(7);
  });
});
