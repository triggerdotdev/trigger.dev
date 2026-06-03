import { lazy } from "react";
import type { CodeHighlighterPlugin } from "streamdown";

export const StreamdownRenderer = lazy(() =>
  Promise.all([import("streamdown"), import("@streamdown/code"), import("./shikiTheme")]).then(
    ([{ Streamdown }, { createCodePlugin }, { triggerDarkTheme }]) => {
      // Type assertion needed: @streamdown/code and streamdown resolve different shiki
      // versions under pnpm, causing structurally-identical CodeHighlighterPlugin types
      // to be considered incompatible (different BundledLanguage string unions).
      const codePlugin = createCodePlugin({
        themes: [triggerDarkTheme, triggerDarkTheme],
      }) as unknown as CodeHighlighterPlugin;

      return {
        default: ({
          children,
          isAnimating = false,
        }: {
          children: string;
          isAnimating?: boolean;
        }) => (
          <Streamdown isAnimating={isAnimating} plugins={{ code: codePlugin }}>
            {children}
          </Streamdown>
        ),
      };
    }
  )
);
