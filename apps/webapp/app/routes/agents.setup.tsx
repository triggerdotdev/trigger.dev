import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { useState } from "react";
import { z } from "zod";
import { Button } from "~/components/primitives/Buttons";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Paragraph } from "~/components/primitives/Paragraph";
import { prisma } from "~/db.server";
import { requireUser } from "~/services/auth.server";
import { logger } from "~/services/logger.server";

const SetupSchema = z.object({
  agentName: z.string().min(1, "Agent name is required"),
  model: z.enum(["claude-3.5-sonnet", "claude-3-opus", "gpt-4-turbo"]),
  messagingPlatform: z.enum(["slack", "discord", "telegram"]),
  tools: z.string(), // JSON string array
  slackWorkspaceId: z.string().optional(),
  slackWebhookToken: z.string().optional(),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  return json({ user });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const user = await requireUser(request);
  const formData = await request.formData();

  try {
    const data = SetupSchema.parse({
      agentName: formData.get("agentName"),
      model: formData.get("model"),
      messagingPlatform: formData.get("messagingPlatform"),
      tools: formData.get("tools"),
      slackWorkspaceId: formData.get("slackWorkspaceId"),
      slackWebhookToken: formData.get("slackWebhookToken"),
    });

    // Parse tools JSON
    const tools = JSON.parse(data.tools || "[]");

    // Create agent config in database
    const agentConfig = await prisma.agentConfig.create({
      data: {
        name: data.agentName,
        model: data.model,
        messagingPlatform: data.messagingPlatform,
        tools: tools,
        slackWorkspaceId: data.slackWorkspaceId || null,
        slackWebhookToken: data.slackWebhookToken || null,
        userId: user.id,
        status: "provisioning",
      },
    });

    logger.info("Agent created", {
      agentId: agentConfig.id,
      userId: user.id,
      name: data.agentName,
    });

    // Trigger provisioning endpoint to spin up container
    try {
      const provisionResponse = await fetch("http://localhost:3000/api/agents/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: agentConfig.id }),
      });

      if (!provisionResponse.ok) {
        logger.error("Provisioning failed", {
          agentId: agentConfig.id,
          status: provisionResponse.status,
        });
      }
    } catch (error) {
      logger.error("Failed to call provisioning endpoint", { error });
    }

    return redirect(`/agents/${agentConfig.id}/status`);
  } catch (error) {
    logger.error("Failed to create agent", { error, userId: user.id });
    return json(
      { error: error instanceof Error ? error.message : "Failed to create agent" },
      { status: 400 }
    );
  }
};

export default function AgentSetup() {
  const navigation = useNavigation();
  const actionData = useActionData<typeof action>();
  const [selectedTools, setSelectedTools] = useState<string[]>([]);

  const toolOptions = [
    { id: "web-search", label: "Web Search" },
    { id: "code-execution", label: "Code Execution" },
    { id: "file-operations", label: "File Operations" },
    { id: "api-calls", label: "API Calls" },
  ];

  const handleToolChange = (toolId: string, checked: boolean) => {
    if (checked) {
      setSelectedTools([...selectedTools, toolId]);
    } else {
      setSelectedTools(selectedTools.filter((t) => t !== toolId));
    }
  };

  return (
    <PageContainer>
      <PageBody>
        <Header1>Create a New Agent</Header1>
        <Paragraph>Set up your AI agent with model, messaging, and tools</Paragraph>

        <Form method="post" className="max-w-lg space-y-6 mt-8">
          {actionData?.error && (
            <div className="bg-red-50 border border-red-200 rounded p-4 text-red-700">
              {actionData.error}
            </div>
          )}

          {/* Agent Name */}
          <div>
            <label htmlFor="agentName" className="block text-sm font-medium mb-2">
              Agent Name
            </label>
            <input
              type="text"
              id="agentName"
              name="agentName"
              placeholder="My awesome agent"
              className="w-full px-3 py-2 border rounded-md"
              required
            />
          </div>

          {/* Model Selection */}
          <div>
            <label htmlFor="model" className="block text-sm font-medium mb-2">
              AI Model
            </label>
            <select
              id="model"
              name="model"
              className="w-full px-3 py-2 border rounded-md"
              defaultValue="claude-3.5-sonnet"
              required
            >
              <option value="claude-3.5-sonnet">Claude 3.5 Sonnet</option>
              <option value="claude-3-opus">Claude 3 Opus</option>
              <option value="gpt-4-turbo">GPT-4 Turbo</option>
            </select>
          </div>

          {/* Messaging Platform */}
          <div>
            <label htmlFor="messagingPlatform" className="block text-sm font-medium mb-2">
              Messaging Platform
            </label>
            <select
              id="messagingPlatform"
              name="messagingPlatform"
              className="w-full px-3 py-2 border rounded-md"
              defaultValue="slack"
              required
            >
              <option value="slack">Slack</option>
              <option value="discord">Discord</option>
              <option value="telegram">Telegram</option>
            </select>
          </div>

          {/* Tools Selection */}
          <div>
            <Header2>Select Tools</Header2>
            <div className="space-y-3">
              {toolOptions.map((tool) => (
                <label key={tool.id} className="flex items-center">
                  <input
                    type="checkbox"
                    value={tool.id}
                    checked={selectedTools.includes(tool.id)}
                    onChange={(e) => handleToolChange(tool.id, e.target.checked)}
                    className="rounded"
                  />
                  <span className="ml-2">{tool.label}</span>
                </label>
              ))}
            </div>
            <input
              type="hidden"
              name="tools"
              value={JSON.stringify(selectedTools)}
            />
          </div>

          {/* Slack Integration (conditional) */}
          {/* This would be conditional based on messagingPlatform selection */}
          <div>
            <label htmlFor="slackWorkspaceId" className="block text-sm font-medium mb-2">
              Slack Workspace ID (optional)
            </label>
            <input
              type="text"
              id="slackWorkspaceId"
              name="slackWorkspaceId"
              placeholder="T0XXXXXXXX"
              className="w-full px-3 py-2 border rounded-md"
            />
          </div>

          <div>
            <label htmlFor="slackWebhookToken" className="block text-sm font-medium mb-2">
              Slack Webhook Token (optional)
            </label>
            <input
              type="password"
              id="slackWebhookToken"
              name="slackWebhookToken"
              placeholder="xoxb-..."
              className="w-full px-3 py-2 border rounded-md"
            />
          </div>

          <div className="flex gap-3">
            <Button
              type="submit"
              disabled={navigation.state === "submitting"}
              className="bg-blue-600 text-white px-4 py-2 rounded"
            >
              {navigation.state === "submitting" ? "Creating..." : "Create Agent"}
            </Button>
          </div>
        </Form>
      </PageBody>
    </PageContainer>
  );
}
