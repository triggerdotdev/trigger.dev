/**
 * Escape inside the panel closes the panel — but a popover or a dialog is portalled out of
 * the panel's DOM subtree while still bubbling through the React tree, and Radix dismisses
 * those from a document listener that runs after this handler, so the event arrives here
 * undefaulted. Deciding on the DOM target is what tells the two apart.
 */
export function escapeClosesPanel(event: {
  key: string;
  defaultPrevented: boolean;
  /** Whether the event's target is a DOM descendant of the panel. */
  targetInsidePanel: boolean;
}): boolean {
  if (event.key !== "Escape" || event.defaultPrevented) return false;
  return event.targetInsidePanel;
}
