import { task, logger, prompts } from "@trigger.dev/sdk";
import { generateText, generateObject, streamText, tool, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

// ─── Prompt definitions ──────────────────────────────────

export const supportPrompt = prompts.define({
  id: "customer-support",
  description: "System prompt for great customer support interactions",
  model: "gpt-4o",
  config: { temperature: 0.7, maxTokens: 2000 },
  variables: z.object({
    customerName: z.string(),
    plan: z.string(),
    issue: z.string(),
    previousMessages: z.string().optional(),
  }),
  content: `You are a senior customer support agent for Acme SaaS, a project management platform. You handle billing, account, and technical support inquiries with empathy and precision.

## Customer context

- **Name:** {{customerName}}
- **Plan:** {{plan}}
- **Reported issue:** {{issue}}

## Your responsibilities

1. **Diagnose the issue** — Ask clarifying questions if the problem is ambiguous. Do not guess.
2. **Resolve when possible** — Use the tools provided (lookup_order, check_subscription, reset_password, issue_refund, update_billing) to take direct action.
3. **Escalate when necessary** — If you cannot resolve the issue within your authority, use the escalate_to_human tool. Always include a summary of what you've already tried.

## Guidelines

### Tone and language
- Address the customer by their first name.
- Be concise but warm. Avoid corporate jargon.
- Never blame the customer. Use phrases like "I can see that..." or "It looks like..." instead of "You did...".
- If something is our fault, acknowledge it directly: "I'm sorry about that — this shouldn't have happened."

### Billing and refunds
- Customers on the **Free** plan are not eligible for refunds.
- Customers on the **Pro** plan can receive refunds for charges within the last 30 days, up to $500, without manager approval.
- Customers on the **Enterprise** plan: any refund over $200 requires escalation to the billing team.
- If a customer was double-charged, issue a refund immediately and apologize.
- Never share internal pricing tiers or discount structures.

### Account and security
- You can trigger a password reset email but cannot view or change passwords directly.
- If a customer reports unauthorized access, immediately escalate to the security team using escalate_to_human with priority "urgent".
- Do not share account details (email, billing info) without first verifying the customer's identity through their registered email.

### Technical issues
- For issues related to project creation, task boards, or integrations, check our known issues list first.
- If the issue matches a known bug, share the workaround and let the customer know it's being tracked.
- For API-related questions, link to the relevant docs page: https://docs.acme-saas.com/api
- If the issue is not in the known issues list and you cannot diagnose it, escalate to engineering support.

### What you must never do
- Never make up information about product features, pricing, or policies.
- Never promise a timeline for bug fixes or feature releases.
- Never share internal Slack messages, Jira tickets, or employee names.
- Never ask the customer to "try again later" without a concrete reason.

{{#previousMessages}}
## Conversation history

{{previousMessages}}
{{/previousMessages}}

Respond to the customer's issue now. Start by acknowledging their problem, then either resolve it directly or ask the one most important clarifying question.`,
});

export const summarizerPrompt = prompts.define({
  id: "summarizer",
  description: "Summarizes text content",
  model: "gpt-4o-mini",
  config: { temperature: 0.3 },
  variables: z.object({
    text: z.string(),
    maxSentences: z.string().optional(),
  }),
  content: `Summarize the following text{{#maxSentences}} in {{maxSentences}} sentences or fewer{{/maxSentences}}:

{{text}}`,
});

// ─── Test task: resolve prompts locally ──────────────────

export const testPromptsTask = task({
  id: "test-prompts",
  run: async () => {
    const support = await supportPrompt.resolve({
      customerName: "Alice Johnson",
      plan: "Pro",
      issue: "Cannot access billing dashboard",
    });

    logger.info("Support prompt resolved", {
      version: support.version,
      model: support.model,
      text: support.text,
    });

    const summarizer = await summarizerPrompt.resolve({
      text: "Trigger.dev is a platform for building and running background tasks. It provides a TypeScript SDK for defining tasks, and a dashboard for monitoring and managing them.",
      maxSentences: "2",
    });

    logger.info("Summarizer prompt resolved", {
      version: summarizer.version,
      model: summarizer.model,
      text: summarizer.text,
    });

    return {
      supportPrompt: support.text,
      summarizerText: summarizer.text,
    };
  },
});

// ─── AI SDK integration: generateText with prompt ────────

export const generateWithPromptTask = task({
  id: "generate-with-prompt",
  run: async (payload: { customerName: string; plan: string; issue: string }) => {
    const resolved = await supportPrompt.resolve({
      customerName: payload.customerName,
      plan: payload.plan,
      issue: payload.issue,
    });

    // Use with generateText — spread toAISDKTelemetry to link the AI span to the prompt
    const result = await generateText({
      model: openai(resolved.model ?? "gpt-4o-mini"),
      system: resolved.text,
      prompt: `The customer says: "${payload.issue}". Please help them.`,
      ...resolved.toAISDKTelemetry(),
    });

    logger.info("AI response generated", {
      promptVersion: resolved.version,
      promptLabels: resolved.labels,
      responseLength: result.text.length,
    });

    return { response: result.text };
  },
});

// ─── AI SDK integration: summarize with prompt ───────────

export const summarizeTask = task({
  id: "summarize-with-prompt",
  run: async (payload: { text: string; maxSentences?: string }) => {
    const resolved = await summarizerPrompt.resolve({
      text: payload.text,
      maxSentences: payload.maxSentences,
    });

    // Use the resolved prompt as the user prompt directly
    const result = await generateText({
      model: openai("gpt-4o-mini"),
      prompt: resolved.text,
      ...resolved.toAISDKTelemetry({ "task.type": "summarization" }),
    });

    logger.info("Summary generated", {
      promptVersion: resolved.version,
      inputLength: payload.text.length,
      outputLength: result.text.length,
    });

    return { summary: result.text };
  },
});

// ─── AI SDK integration: streamText with prompt ──────────

export const streamWithPromptTask = task({
  id: "stream-with-prompt",
  run: async (payload: { customerName: string; plan: string; issue: string }) => {
    const resolved = await supportPrompt.resolve({
      customerName: payload.customerName,
      plan: payload.plan,
      issue: payload.issue,
    });

    const result = streamText({
      model: openai(resolved.model ?? "gpt-4o-mini"),
      system: resolved.text,
      prompt: `The customer says: "${payload.issue}". Please help them.`,
      tools: {
        check_subscription: tool({
          description: "Look up the customer's current subscription status and plan details",
          inputSchema: z.object({
            customerName: z.string().describe("The customer's name"),
          }),
          execute: async ({ customerName }) => ({
            plan: payload.plan,
            status: "active",
            billingCycle: "monthly",
            nextBillingDate: "2026-04-01",
          }),
        }),
        escalate_to_human: tool({
          description: "Escalate the issue to a human support agent",
          inputSchema: z.object({
            summary: z.string().describe("Summary of the issue and what has been tried"),
            priority: z.enum(["low", "medium", "high", "urgent"]).describe("Urgency level"),
          }),
          execute: async ({ summary, priority }) => ({
            ticketId: "ESC-1234",
            status: "escalated",
            priority,
          }),
        }),
      },
      stopWhen: stepCountIs(3),
      ...resolved.toAISDKTelemetry(),
    });

    let fullText = "";
    for await (const chunk of result.textStream) {
      fullText += chunk;
    }

    logger.info("Streamed response complete", {
      promptVersion: resolved.version,
      responseLength: fullText.length,
    });

    return { response: fullText };
  },
});

// ─── Prompt for structured extraction ────────────────────

export const extractContactPrompt = prompts.define({
  id: "extract-contact",
  description: "Extracts structured contact info from freeform text",
  model: "gpt-4o-mini",
  config: { temperature: 0 },
  variables: z.object({
    text: z.string(),
  }),
  content: `Extract the contact information from the following text. If a field is not present, omit it.

Text:
{{text}}`,
});

// ─── AI SDK integration: generateObject with prompt ──────

export const generateObjectWithPromptTask = task({
  id: "generate-object-with-prompt",
  run: async (payload: { text: string }) => {
    const resolved = await extractContactPrompt.resolve({
      text: payload.text,
    });

    const result = await generateObject({
      model: openai(resolved.model ?? "gpt-4o-mini"),
      system: resolved.text,
      prompt: payload.text,
      schema: z.object({
        name: z.string().describe("Full name, or empty string if not found"),
        email: z.string().describe("Email address, or empty string if not found"),
        phone: z.string().describe("Phone number, or empty string if not found"),
        company: z.string().describe("Company name, or empty string if not found"),
        role: z.string().describe("Job title or role, or empty string if not found"),
      }),
      ...resolved.toAISDKTelemetry(),
    });

    logger.info("Contact extracted", {
      promptVersion: resolved.version,
      contact: result.object,
    });

    return { contact: result.object };
  },
});

// ─── Prompt management SDK methods ───────────────────────

export const testPromptManagement = task({
  id: "test-prompt-management",
  run: async () => {
    // List all prompts
    const allPrompts = await prompts.list();
    logger.info("Listed prompts", { count: allPrompts.data.length, slugs: allPrompts.data.map((p) => p.slug) });

    if (allPrompts.data.length === 0) {
      return { success: false, reason: "No prompts found — deploy first" };
    }

    const slug = allPrompts.data[0].slug;

    // List versions
    const versions = await prompts.versions(slug);
    logger.info("Listed versions", { slug, count: versions.data.length });

    // Resolve the prompt (standalone, not via PromptHandle)
    const resolved = await prompts.resolve(slug, { customerName: "SDK Test", plan: "Enterprise", issue: "Testing management API" });
    logger.info("Resolved prompt standalone", { version: resolved.version, textLength: resolved.text.length });

    // Create an override
    const override = await prompts.createOverride(slug, {
      textContent: "Override from SDK test: Hello {{customerName}} on {{plan}}!",
      model: "gpt-4o-mini",
      commitMessage: "SDK test override",
    });
    logger.info("Created override", { version: override.version });

    // Resolve again — should get the override
    const resolvedOverride = await prompts.resolve(slug, { customerName: "SDK Test", plan: "Enterprise", issue: "Testing override" });
    logger.info("Resolved with override", { version: resolvedOverride.version, text: resolvedOverride.text });

    // Update the override
    await prompts.updateOverride(slug, {
      textContent: "Updated override: Hi {{customerName}} ({{plan}})!",
      commitMessage: "SDK test update",
    });
    logger.info("Updated override");

    // Remove the override
    await prompts.removeOverride(slug);
    logger.info("Removed override");

    // Promote the first version to current
    if (versions.data.length > 0) {
      const v = versions.data[versions.data.length - 1].version; // oldest version
      await prompts.promote(slug, v);
      logger.info("Promoted version", { version: v });
    }

    return { success: true, slug, versionsCount: versions.data.length };
  },
});
