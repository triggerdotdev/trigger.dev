import { useNavigate, useSubmit } from "@remix-run/react";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { useOptionalUser } from "~/hooks/useUser";
import { adminPath } from "~/utils/pathBuilder";

/**
 * App-wide keyboard shortcuts, mounted once at the root so they work on every page regardless of
 * which side menu (if any) is rendered. Add new global shortcuts here.
 *
 * Renders nothing. Reads the user from the root loader via `useOptionalUser`, so on unauthenticated
 * pages there is simply no admin and nothing is registered.
 */
export function GlobalShortcuts() {
  const user = useOptionalUser();
  const navigate = useNavigate();
  const submit = useSubmit();

  const isImpersonating = Boolean(user?.isImpersonating);
  const isAdmin = Boolean(user?.admin) || isImpersonating;

  // ⌘/Ctrl+Esc: admins jump to the admin dashboard; while impersonating the same shortcut stops
  // impersonating instead. `enabledOnInputElements` so it still fires while a field is focused.
  useShortcutKeys({
    shortcut: isAdmin
      ? { modifiers: ["mod"], key: "esc", enabledOnInputElements: true }
      : undefined,
    action: () => {
      if (isImpersonating) {
        submit(null, { action: "/resources/impersonation", method: "delete" });
      } else {
        navigate(adminPath());
      }
    },
  });

  return null;
}
