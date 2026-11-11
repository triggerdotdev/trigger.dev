import { z } from "zod";

export const API_KEY_NOTE_MAX_LENGTH = 200;

export const API_KEY_NOTE_TOO_LONG_MESSAGE = `Notes can be at most ${API_KEY_NOTE_MAX_LENGTH} characters`;

/**
 * An API key's note as it's stored: one line, trimmed, or null when there's nothing left.
 * Line breaks and runs of whitespace collapse to single spaces, so a pasted paragraph still
 * fits the one-line note.
 */
export function normalizeApiKeyNote(value: string | null | undefined): string | null {
  const note = (value ?? "").replace(/\s+/g, " ").trim();
  return note.length > 0 ? note : null;
}

/** Whether a note typed into the dialog is over the limit once it's normalized. */
export function isApiKeyNoteTooLong(value: string): boolean {
  return (normalizeApiKeyNote(value)?.length ?? 0) > API_KEY_NOTE_MAX_LENGTH;
}

/** Form field for an optional note: empty or missing becomes null, longer than the limit fails. */
export const ApiKeyNoteField = z
  .string()
  .optional()
  .transform((value) => normalizeApiKeyNote(value))
  .refine((note) => note === null || note.length <= API_KEY_NOTE_MAX_LENGTH, {
    message: API_KEY_NOTE_TOO_LONG_MESSAGE,
  });
