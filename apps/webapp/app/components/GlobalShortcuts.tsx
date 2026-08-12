import { useNavigate, useSubmit } from "@remix-run/react";
import { useEffect } from "react";
import { useIsImpersonating } from "~/hooks/useOrganizations";
import { useOptionalUser } from "~/hooks/useUser";
import { adminPath } from "~/utils/pathBuilder";

/** App-wide keyboard shortcuts, mounted once at the root so they work everywhere. Renders nothing. */
export function GlobalShortcuts() {
  const user = useOptionalUser();
  const isImpersonating = useIsImpersonating();
  const navigate = useNavigate();
  const submit = useSubmit();

  const isAdmin = Boolean(user?.admin) || isImpersonating;

  useEffect(() => {
    if (!isAdmin) return;

    const onKeyDown = (event: KeyboardEvent) => {
      // Admin escape hatch: Cmd+Option+A (Ctrl+Alt+A on Windows) opens the admin dashboard, or stops
      // impersonating. Avoids Escape — Chrome/macOS never delivers a keydown for Escape+modifier (why
      // the old Cmd+Esc did nothing). Matched on `event.code`, not `event.key`, because Option makes
      // "A" report "å" (so a raw listener, not the `event.key`-based useShortcutKeys hook).
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
