import { useNavigation } from "@remix-run/react";
import { Spinner } from "../primitives/Spinner";

export function PageNavigationIndicator() {
  const navigation = useNavigation();
  if (navigation.state === "loading") {
    return <Spinner color="muted" className="h-4 w-4" />;
  }
}
