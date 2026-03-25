import { openai } from "@ai-sdk/openai";
import { generateText, type LanguageModelV1 } from "ai";
import { env } from "~/env.server";

/**
 * Result type for title generation
 */
export type AIQueryTitleResult =
  | { success: true; title: string }
  | { success: false; error: string };

/**
 * Service for generating concise titles for SQL queries using AI
 */
export class AIQueryTitleService {
  constructor(private readonly model: LanguageModelV1 = openai("gpt-4o-mini")) {}

  /**
   * Generate a concise title for a SQL query
   */
  async generateTitle(query: string): Promise<AIQueryTitleResult> {
    if (!env.OPENAI_API_KEY) {
      return { success: false, error: "OpenAI API key is not configured" };
    }

    try {
      const result = await generateText({
        model: this.model,
        system: `You are a helpful assistant that generates concise titles for SQL queries.

Your task is to create a short, descriptive title (5-10 words) that summarizes what the query does.

Guidelines:
- Focus on the main purpose/intent of the query
- Use plain language, not technical SQL terms
- Start with an action verb when appropriate (e.g., "Count", "List", "Show", "Find")
- Be specific about what data is being retrieved
- Do not include quotes around the title
- Do not include punctuation at the end

Examples:
- "Failed runs by hour over 7 days"
- "Top 50 most expensive task runs"
- "Run counts grouped by status"
- "Average execution time by task"
- "Recent runs with errors"`,
        prompt: `Generate a concise title for this SQL query:\n\n${query}`,
        maxTokens: 50,
        experimental_telemetry: {
          isEnabled: true,
          metadata: {
            feature: "ai-query-title",
          },
        },
      });

      const title = result.text.trim();

      if (!title) {
        return { success: false, error: "No title generated" };
      }

      return { success: true, title };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to generate title",
      };
    }
  }
}
