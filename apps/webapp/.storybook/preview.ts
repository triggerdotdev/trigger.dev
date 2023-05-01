import type { Preview } from "@storybook/react";
import "../styles/tailwind-include.css";

const preview: Preview = {
  parameters: {
    actions: { argTypesRegex: "^on[A-Z].*" },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/,
      },
    },
    backgrounds: {
      default: "Dark",
      values: [
        {
          name: "Dark",
          value: "#030713",
        },
      ],
    },
  },
};

export default preview;
