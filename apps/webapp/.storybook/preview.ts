import type { Preview } from "@storybook/react";
import "../app/tailwind.css";

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
      default: "App background",
      values: [
        {
          name: "App background",
          value: "#0B1018",
        },
      ],
    },
  },
};

export default preview;
