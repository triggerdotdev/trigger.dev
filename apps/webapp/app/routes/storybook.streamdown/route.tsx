import { Suspense } from "react";
import { StreamdownRenderer } from "~/components/code/StreamdownRenderer";
import { Header2 } from "~/components/primitives/Headers";

const sampleMarkdown = `# Streamdown Rendering

This is a paragraph with **bold**, *italic*, and \`inline code\` formatting.

## Code Block (TypeScript)

\`\`\`typescript
import { task } from "@trigger.dev/sdk";

export const myTask = task({
  id: "my-task",
  run: async (payload: { message: string }) => {
    const result = await processMessage(payload.message);
    this.logger.info("Task completed", { result });
    return { success: true, count: 42 };
  },
});
\`\`\`

## Code Block (JSON)

\`\`\`json
{
  "id": "run_1234",
  "status": "completed",
  "output": {
    "success": true,
    "count": 42
  }
}
\`\`\`

## Lists

- First item
- Second item with \`code\`
- Third item

1. Ordered first
2. Ordered second
3. Ordered third

## Table

| Feature | Status | Notes |
|---------|--------|-------|
| Syntax highlighting | Done | Custom Shiki theme |
| Markdown rendering | Done | Streamdown v2 |
| Lazy loading | Done | SSR safe |

## Blockquote

> This is a blockquote with some **bold** text and a [link](https://trigger.dev).

---

That's all the elements.
`;

const codeOnlyMarkdown = `Here's a function that demonstrates the color palette:

\`\`\`typescript
const API_URL = "https://api.trigger.dev";
const MAX_RETRIES = 3;

interface TaskConfig {
  id: string;
  retry: { maxAttempts: number };
}

export async function executeTask(config: TaskConfig): Promise<boolean> {
  // Validate the configuration
  if (!config.id || config.retry.maxAttempts < 1) {
    throw new Error("Invalid task config");
  }

  for (let i = 0; i < MAX_RETRIES; i++) {
    const response = await fetch(\`\${API_URL}/tasks/\${config.id}\`);
    const data = response.json();

    if (response.ok) {
      return true;
    }
  }

  return false;
}
\`\`\`
`;

export default function Story() {
  return (
    <div className="flex flex-col items-start gap-y-8 p-8">
      <div className="max-w-3xl">
        <Header2 className="mb-4">Full Markdown</Header2>
        <div className="streamdown-container rounded-lg border border-charcoal-700 bg-charcoal-900 p-6 text-sm text-text-bright/90">
          <Suspense fallback={<p className="text-text-dimmed">Loading streamdown...</p>}>
            <StreamdownRenderer>{sampleMarkdown}</StreamdownRenderer>
          </Suspense>
        </div>
      </div>

      <div className="max-w-3xl">
        <Header2 className="mb-4">Code Highlighting Theme</Header2>
        <div className="streamdown-container rounded-lg border border-charcoal-700 bg-charcoal-900 p-6 text-sm text-text-bright/90">
          <Suspense fallback={<p className="text-text-dimmed">Loading streamdown...</p>}>
            <StreamdownRenderer>{codeOnlyMarkdown}</StreamdownRenderer>
          </Suspense>
        </div>
      </div>
    </div>
  );
}
