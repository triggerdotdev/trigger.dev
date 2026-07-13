import { useNavigate, useSubmit } from "@remix-run/react";
import { useEffect } from "react";
import { useOptionalUser } from "~/hooks/useUser";
import { adminPath } from "~/utils/pathBuilder";

/**
 * App-wide keyboard shortcuts, mounted once at the root so they work on every page regardless of
 * which side menu (if any) is rendered. Renders nothing.
 */
export function GlobalShortcuts() {
  const user = useOptionalUser();
  const navigate = useNavigate();
  const submit = useSubmit();

  const isImpersonating = Boolean(user?.isImpersonating);
  const isAdmin = Boolean(user?.admin) || isImpersonating;

  useEffect(() => {
    if (!isAdmin) return;

    const onKeyDown = (event: KeyboardEvent) => {
      // Admin-only escape hatch: Cmd+Option+A (Ctrl+Alt+A on Windows) opens the admin dashboard, or
      // stops impersonating while impersonating. Two modifiers keep it clear of every user-facing
      // shortcut, and it deliberately avoids Escape (Chrome/macOS never delivers a keydown for
      // Escape while a modifier is held, which is why the old Cmd+Esc did nothing).
      //
      // Matched on `event.code` (the physical key) rather than `event.key`, because holding Option
      // on macOS makes the "A" key report an alternate character ("å"); the physical code stays
      // `KeyA` regardless. This is why it's a raw listener and not the `useShortcutKeys` hook, which
      // matches on `event.key`.
      if (event.code !== "KeyA" || !event.altKey || !(event.metaKey || event.ctrlKey)) {
        return;
      }
      event.preventDefault();
      if (isImpersonating) {
        submit(null, { action: "/resources/impersonation", method: "delete" });
      } else {
        navigate(adminPath());
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isAdmin, isImpersonating, navigate, submit]);

  return null;
}
