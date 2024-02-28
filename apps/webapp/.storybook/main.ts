import type { StorybookConfig } from "@storybook/react-webpack5";
import path from "path";

const root = path.resolve(__dirname, "../app");

const config: StorybookConfig = {
  webpackFinal: async (config) => {
    return {
      ...config,
      resolve: {
        ...config.resolve,
        alias: {
          ...(config.resolve?.alias ?? {}),
          "~": root,
        },
        extensions: [
          ...(config.resolve?.extensions ?? []),
          ...[".ts", ".tsx", ".js", ".jsx", ".mdx"],
        ],
      },
      module: {
        ...config.module,
        rules: [
          ...(config.module?.rules ?? []),
          {
            test: /\,css&/,
            use: [
              {
                loader: "postcss-loader",
                options: {
                  ident: "postcss",
                  plugins: [require("tailwindcss"), require("autoprefixer")],
                },
              },
            ],
            include: path.resolve(__dirname, "../"),
          },
        ],
      },
    };
  },
  stories: ["../app/**/stories/*.mdx", "../app/**/stories/*.stories.@(js|jsx|ts|tsx)"],
  addons: [
    "@storybook/addon-links",
    "@storybook/addon-essentials",
    "@storybook/addon-interactions",
    "storybook-addon-variants",
    "storybook-addon-designs",
  ],
  framework: {
    name: "@storybook/react-webpack5",
    options: {},
  },
  docs: {
    autodocs: "tag",
  },
  staticDirs: [path.resolve("public")],
};
export default config;
