import { useLocation } from "@remix-run/react";
import { useToast } from "~/components/primitives/Toast";
import { useAppOrigin, usePublicAppOrigin } from "~/hooks/useAppOrigin";
import { useHasAdminAccess } from "~/hooks/useUser";

export function useCopyPublicUrl(): { enabled: boolean; copy: () => void } {
  const { pathname, search, hash } = useLocation();
  const appOrigin = useAppOrigin();
  const publicAppOrigin = usePublicAppOrigin();
  const hasAdminAccess = useHasAdminAccess();
  const toast = useToast();

  const isInternalPath = pathname.startsWith("/admin") || pathname.startsWith("/@");
  const enabled =
    hasAdminAccess &&
    publicAppOrigin !== undefined &&
    publicAppOrigin !== appOrigin &&
    !isInternalPath;

  const copy = () => {
    if (!enabled) return;

    const publicUrl = new URL(pathname + search + hash, publicAppOrigin).toString();
    navigator.clipboard.writeText(publicUrl).then(
      () => toast.success("Copied public URL"),
      () => toast.error("Couldn't copy public URL")
    );
  };

  return { enabled, copy };
}
