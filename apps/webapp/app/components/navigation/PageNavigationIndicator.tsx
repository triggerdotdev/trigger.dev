import { useNavigation } from "@remix-run/react";
import { Spinner } from "../primitives/Spinner";
import { cn } from "~/utils/cn";

export function PageNavigationIndicator({ className }: { className?: string }) {
  const navigation = useNavigation();
  if (navigation.state === "loading") {
    return <Spinner color="blue" className={cn("h-4 w-4", className)} />;
  }
}
