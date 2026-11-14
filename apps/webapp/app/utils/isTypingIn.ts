// Inputs that take no typing: a ticked checkbox keeps the focus, and Escape must still work there.
const NON_TEXT_INPUT_TYPES = new Set(["checkbox", "radio", "button", "submit", "reset", "image"]);

/** The focus is somewhere Escape belongs to: a text field, a select, an open menu or listbox. */
export function isTypingIn(element: Element | null) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  if (element instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has(element.type);
  }
  return (
    element.isContentEditable ||
    element.closest("textarea, select, [role='listbox'], [role='menu']") !== null
  );
}
