/**
 * The chips the panel can offer. `resolver.ts` orders the slots and applies the
 * cap. Pure: no React, no server imports, no clock beyond the `now` passed in.
 *
 * Split by responsibility; this file is the registry's public face.
 */

export { PROMPT_SLOTS,  type PromptSlot } from "./prompt-chips";
export { GENERIC_PROMPTS } from "./docs-prompts";
export {  pageDefaultPrompts, pageSlotPrompts } from "./page-prompts";
export {
  
  contextualPromptsBySlot,
  
  
  
  
  
} from "./signal-prompts";
