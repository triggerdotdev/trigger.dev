import type { Preview } from "@storybook/react";
import "../app/tailwind.css";
import { createRemixStub } from "@remix-run/testing";
import React from "react";
import { LocaleContextProvider } from "../app/components/primitives/LocaleProvider";
import { OperatingSystemContextProvider } from "../app/components/primitives/OperatingSystemProvider";

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
      const RemixStub = createRemixStub([
        {
          path: "/*",
          Component: Story,
        },
      ]);

      return (
        <OperatingSystemContextProvider platform="mac">
          <LocaleContextProvider locales={window.navigator.languages as string[]}>
            <RemixStub initialEntries={["/"]} />
          </LocaleContextProvider>
        </OperatingSystemContextProvider>
      );
    },
  ],
};

export default preview;
