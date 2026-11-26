// Ask AI settings. Pages are prerendered, so the key must also be set at build time for the
// button to show.
export const askEnabled = () => !!process.env.ANTHROPIC_API_KEY;
export const askModel = () => process.env.ASK_AI_MODEL || "claude-sonnet-5-5";
