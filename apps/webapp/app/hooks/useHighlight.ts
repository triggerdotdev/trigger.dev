import { H } from "highlight.run";
import { useUserChanged } from "./useUser";

export function useHighlight() {
  useUserChanged((user) => {
    if (!user) {
      return;
    }

    H.identify(user.id, {
      email: user.email,
    });
  });
}
