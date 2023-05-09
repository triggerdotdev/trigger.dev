import type { StorybookConfig } from "@storybook/react-webpack5";
import path from "path";

const root = path.resolve(__dirname, "../app/");
console.log("storybook root", root);

const config: StorybookConfig = {
  webpackFinal: async (config) => {
    return {
      ...config,
      resolve: {
        ...config.resolve,
        alias: {
          ...(config.resolve?.alias ?? {}),
          "~/": root,
        },
        extensions: [
          ...(config.resolve?.extensions ?? []),
          ...[".ts", ".tsx", ".js", ".jsx", ".mdx"],
        ],
      },
    };
  },
  stories: [
    "../app/**/stories/*.mdx",
    "../app/**/stories/*.stories.@(js|jsx|ts|tsx)",
  ],
  addons: [
    "@storybook/addon-links",
    "@storybook/addon-essentials",
    "@storybook/addon-interactions",
    "storybook-addon-variants",
    "storybook-addon-designs",
    {
      name: "@storybook/addon-styling",
      options: {
        // Check out https://github.com/storybookjs/addon-styling/blob/main/docs/api.md
        // For more details on this addon's options.
        postCss: true,
      },
    },
  ],
  framework: {
    name: "@storybook/react-webpack5",
    options: {},
  },
  docs: {
    autodocs: "tag",
  },
  staticDirs: [path.resolve("public"), path.resolve("app/styles")],
};
export default config;
