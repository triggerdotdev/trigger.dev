#!/usr/bin/env bash
set -euo pipefail

# Research a single LLM model using Claude Code CLI and output structured JSON.
# Usage: ./scripts/research-model.sh <model-name>
#
# Example:
#   ./scripts/research-model.sh gpt-4o
#   → {"provider":"openai","description":"...","contextWindow":128000,...}

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <model-name>" >&2
  exit 1
fi

MODEL_NAME="$1"
MAX_RETRIES="${2:-3}"

PROMPT="Research the LLM model '${MODEL_NAME}' and return ONLY a valid JSON object (no markdown, no explanation, no code fences) with these exact fields:

{
  \"provider\": \"<provider-id>\",
  \"description\": \"<1-2 sentence description of the model>\",
  \"contextWindow\": <max input context window in tokens, or null if unknown>,
  \"maxOutputTokens\": <max output tokens, or null if unknown>,
  \"capabilities\": [<list of capability strings>],
  \"releaseDate\": \"<YYYY-MM-DD or null if unknown>\",
  \"isHidden\": <true if deprecated, false otherwise>,
  \"supportsStructuredOutput\": <true/false>,
  \"supportsParallelToolCalls\": <true/false>,
  \"supportsStreamingToolCalls\": <true/false>,
  \"deprecationDate\": \"<YYYY-MM-DD or null if no known sunset date>\",
  \"knowledgeCutoff\": \"<YYYY-MM-DD or null if unknown>\"
}

Rules:
- provider must be one of: \"openai\", \"anthropic\", \"google\", \"meta\", \"mistral\", \"cohere\", \"ai21\", \"amazon\", \"xai\", \"deepseek\", \"qwen\", \"perplexity\" or the correct provider lowercase id
- description should be concise and factual (what the model is good at, its position in the provider's lineup)
- contextWindow is the maximum input context in tokens (e.g. 128000 for GPT-4o, 200000 for Claude Sonnet 4)
- maxOutputTokens is the maximum output the model can generate in a single response
- capabilities should be drawn from: \"vision\", \"tool_use\", \"streaming\", \"json_mode\", \"extended_thinking\", \"code_execution\", \"image_generation\", \"audio_input\", \"audio_output\", \"embedding\", \"fine_tunable\"
- Only include capabilities you are confident the model supports
- releaseDate is when the model was first publicly available (API launch date), in YYYY-MM-DD format. Use null if unknown. If the model is a dated variant (e.g. gpt-4o-2024-08-06), the date in the name IS the release date.
- isHidden should be true if the model is deprecated, discontinued, no longer available via API, or superseded by a newer version. Examples: gpt-3.5-turbo, claude-1.x, claude-2.x, text-davinci-003, gpt-4-0314 are hidden. Current/active models like gpt-4o, claude-sonnet-4-6, gemini-2.5-flash are NOT hidden.
- supportsStructuredOutput: true if the model reliably follows JSON schemas / structured output mode (e.g. OpenAI's response_format, Anthropic's tool_use for structured output). false for older models that don't support it well.
- supportsParallelToolCalls: true if the model can call multiple tools in a single assistant turn. Most modern models support this.
- supportsStreamingToolCalls: true if the model supports streaming partial tool call arguments as they're generated.
- deprecationDate: the date the provider has announced the model will be sunset/removed from their API, in YYYY-MM-DD format. Use null if no deprecation date has been announced. Only use dates that have been officially published by the provider.
- knowledgeCutoff: the date when the model's training data ends, in YYYY-MM-DD format. Use null if unknown. This is different from releaseDate — it's when the training data was cut off, not when the model launched.
- Output ONLY the JSON object, nothing else"

for attempt in $(seq 1 "$MAX_RETRIES"); do
  RESULT=$(claude -p "$PROMPT" --model opus --output-format json --permission-mode bypassPermissions --tools WebSearch,WebFetch 2>/dev/null) && {
    echo "$RESULT"
    exit 0
  }
  if [[ "$attempt" -lt "$MAX_RETRIES" ]]; then
    echo "  Retry $attempt/$MAX_RETRIES for $MODEL_NAME..." >&2
    sleep 2
  fi
done

echo "  Failed after $MAX_RETRIES attempts for $MODEL_NAME" >&2
exit 1
