import type { Preview } from "@storybook/react";
import "../app/tailwind.css";
import { unstable_createRemixStub } from "@remix-run/testing";
import React from "react";

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
  decorators: [
    (Story) => {
      const RemixStub = unstable_createRemixStub([
        {
          path: "/*",
          element: <Story />,
        },
      ]);

      return (
        <div>
          <RemixStub initialEntries={["/"]} />
        </div>
      );
    },
  ],
};

export default preview;
