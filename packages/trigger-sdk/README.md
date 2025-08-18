<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/a45d1fa2-0ae8-4a39-4409-f4f934bfae00/public">
  <source media="(prefers-color-scheme: light)" srcset="https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/3f5ad4c1-c4c8-4277-b622-290e7f37bd00/public">
  <img alt="Trigger.dev logo" src="https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/a45d1fa2-0ae8-4a39-4409-f4f934bfae00/public">
</picture>

# Official TypeScript SDK for Trigger.dev

### 🤖 TypeScript SDK for building AI agents & workflows

[![npm version](https://img.shields.io/npm/v/@trigger.dev/sdk.svg)](https://www.npmjs.com/package/@trigger.dev/sdk)
[![npm downloads](https://img.shields.io/npm/dm/@trigger.dev/sdk.svg)](https://www.npmjs.com/package/@trigger.dev/sdk)
[![GitHub stars](https://img.shields.io/github/stars/triggerdotdev/trigger.dev?style=social)](https://github.com/triggerdotdev/trigger.dev)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Open Source](https://img.shields.io/badge/Open%20Source-%E2%9D%A4-red)](https://github.com/triggerdotdev/trigger.dev)

[Discord](https://trigger.dev/discord) | [Website](https://trigger.dev) | [Issues](https://github.com/triggerdotdev/trigger.dev/issues) | [Docs](https://trigger.dev/docs) | [Examples](https://trigger.dev/docs/examples)

</div>

The **Trigger.dev SDK** enables you to create reliable, long-running AI agents and workflows in your TypeScript applications. Connect to the Trigger.dev platform (cloud or self-hosted) to execute jobs without timeouts, with built-in retries and monitoring.

## ✨ What you get with this SDK

- **Write normal async code** - No special syntax, just regular TypeScript functions
- **No timeouts** - Tasks can run for hours or days without failing
- **Built-in reliability** - Automatic retries, error handling, and durable execution
- **Real-time observability** - Watch your tasks execute with full OpenTelemetry tracing
- **Local development** - Test and debug tasks locally with the same environment
- **Checkpoint-resume system** - Efficient resource usage with automatic state management
- **50+ integrations** - Pre-built connectors for AI, databases, and external services
- **Framework agnostic** - Works with Next.js, Express, Fastify, Remix, and more

## 🚀 Quick Start

### Installation

```bash
npm install @trigger.dev/sdk
# or
yarn add @trigger.dev/sdk
# or
pnpm add @trigger.dev/sdk
```

### Basic Usage

```typescript
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";

const client = new TriggerClient({
  id: "my-app",
  apiKey: process.env.TRIGGER_API_KEY!,
});

// Define a background task - just normal async code
export const generateContent = task({
  id: "generate-content",
  retry: {
    maxAttempts: 3,
  },
  run: async ({ theme, description }: { theme: string; description: string }) => {
    // Generate text with OpenAI
    const textResult = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: `Create content about ${theme}: ${description}` }],
    });

    if (!textResult.choices[0]) {
      throw new Error("No content generated, retrying...");
    }

    // Generate an image
    const imageResult = await openai.images.generate({
      model: "dall-e-3",
      prompt: `Create an image for: ${theme}`,
    });

    if (!imageResult.data[0]) {
      throw new Error("No image generated, retrying...");
    }

    return {
      text: textResult.choices[0].message.content,
      image: imageResult.data[0].url,
    };
  },
});

// Trigger the task from your app
import { tasks } from "@trigger.dev/sdk/v3";

const handle = await tasks.trigger<typeof generateContent>("generate-content", {
  theme: "AI automation",
  description: "How AI is transforming business workflows",
});
```

### Scheduled Tasks & Workflows

```typescript
import { schedules } from "@trigger.dev/sdk/v3";

// Scheduled task - runs every Monday at 9 AM
export const weeklyReport = schedules.task({
  id: "weekly-report",
  cron: "0 9 * * MON",
  run: async () => {
    // Multi-step workflow with automatic retries
    const data = await analyzeMetrics.triggerAndWait({
      timeframe: "week",
    });

    const report = await generateReport.triggerAndWait({
      data: data.output,
      format: "pdf",
    });

    // Send to team - runs in parallel
    await Promise.all([
      sendEmail.trigger({
        to: "team@company.com",
        subject: "Weekly Report",
        attachment: report.output.url,
      }),
      uploadToS3.trigger({
        file: report.output,
        bucket: "reports",
      }),
    ]);

    return { success: true, reportId: report.output.id };
  },
});
```

## 📚 Documentation

- **[Getting Started Guide](https://trigger.dev/docs/introduction)** - Complete setup walkthrough
- **[API Reference](https://trigger.dev/docs/sdk/introduction)** - Detailed API documentation
- **[Examples](https://trigger.dev/docs/examples)** - Real-world examples and use cases
- **[Integrations](https://trigger.dev/docs/integrations)** - Pre-built integrations catalog
- **[Best Practices](https://trigger.dev/docs/guides/best-practices)** - Production tips and patterns

## 🔧 Framework Support

Trigger.dev works seamlessly with popular frameworks:

- **[Next.js](https://trigger.dev/docs/guides/frameworks/nextjs)** - App Router and Pages Router
- **[Express](https://trigger.dev/docs/guides/frameworks/express)** - Traditional Node.js apps
- **[Fastify](https://trigger.dev/docs/guides/frameworks/fastify)** - High-performance web framework
- **[Remix](https://trigger.dev/docs/guides/frameworks/remix)** - Full-stack web framework
- **[NestJS](https://trigger.dev/docs/guides/frameworks/nestjs)** - Enterprise Node.js framework

## 🧩 Popular Integrations

```typescript
// Use any npm package - no special integrations needed
import OpenAI from "openai";
import { PrismaClient } from "@prisma/client";
import { Resend } from "resend";

export const processWithAI = task({
  id: "process-with-ai",
  run: async ({ input }: { input: string }) => {
    // OpenAI
    const openai = new OpenAI();
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: input }],
    });

    // Database
    const prisma = new PrismaClient();
    await prisma.result.create({
      data: { content: completion.choices[0].message.content },
    });

    // Email
    const resend = new Resend();
    await resend.emails.send({
      from: "noreply@example.com",
      to: "user@example.com",
      subject: "Processing Complete",
      text: completion.choices[0].message.content,
    });

    return { success: true };
  },
});
```

## 🏃‍♂️ Getting Started

### 1. Install the SDK

```bash
npm install @trigger.dev/sdk
```

### 2. Set up your project

```bash
npx @trigger.dev/cli@latest init
```

### 3. Connect to Trigger.dev

Choose your deployment option:

- **[Trigger.dev Cloud](https://cloud.trigger.dev)** - Managed service (recommended)
- **[Self-hosted](https://trigger.dev/docs/self-hosting)** - Deploy on your infrastructure

### 4. Deploy your jobs

```bash
npx @trigger.dev/cli@latest deploy
```

Or follow our comprehensive [Getting Started Guide](https://trigger.dev/docs/introduction).

## 💡 Example Tasks

Check out our [examples repository](https://github.com/triggerdotdev/trigger.dev/tree/main/examples) for production-ready workflows:

- [AI agents & workflows](https://trigger.dev/docs/examples) - Build invincible AI agents with tools and memory
- [Video processing with FFmpeg](https://trigger.dev/docs/examples/ffmpeg) - Process videos without timeouts
- [PDF generation & processing](https://trigger.dev/docs/examples) - Convert documents at scale
- [Email campaigns](https://trigger.dev/docs/examples) - Multi-step email automation
- [Data pipelines](https://trigger.dev/docs/examples) - ETL processes and database sync
- [Web scraping](https://trigger.dev/docs/examples) - Scrape websites with Puppeteer

## 🤝 Community & Support

- **[Discord Community](https://trigger.dev/discord)** - Get help and share ideas
- **[GitHub Issues](https://github.com/triggerdotdev/trigger.dev/issues)** - Bug reports and feature requests
- **[Twitter](https://twitter.com/triggerdotdev)** - Latest updates and news
- **[Blog](https://trigger.dev/blog)** - Tutorials and best practices

## 📦 Related Packages

- **[@trigger.dev/cli](https://www.npmjs.com/package/@trigger.dev/cli)** - Command line interface
- **[@trigger.dev/react-hooks](https://www.npmjs.com/package/@trigger.dev/react-hooks)** - React hooks for real-time job monitoring
- **[@trigger.dev/nextjs](https://www.npmjs.com/package/@trigger.dev/nextjs)** - Next.js specific utilities

## 📄 License

MIT License - see the [LICENSE](https://github.com/triggerdotdev/trigger.dev/blob/main/LICENSE) file for details.

## ⭐ Contributing

We love contributions! Please see our [Contributing Guide](https://github.com/triggerdotdev/trigger.dev/blob/main/CONTRIBUTING.md) for details on how to get started.

---

<div align="center">
  <strong>Built with ❤️ by the Trigger.dev team</strong>
</div>
