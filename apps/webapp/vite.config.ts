import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { expressDevServer } from "remix-express-dev-server";
import { installGlobals } from "@remix-run/node";
installGlobals({ nativeFetch: true });

const MODE = process.env.NODE_ENV;

export default defineConfig({
  ssr: {
    noExternal: ["react-use"],
  },
  optimizeDeps: {
    include: ["react-use"],
    exclude: ["fsevents", "https"],
  },
  build: {
    target: "esnext",
    cssMinify: MODE === "production",
    rollupOptions: {
      external: [
        /node:.*/,
        /.*\.node$/,
        "https",
        "stream",
        "crypto",
        "fsevents",
        "@radix-ui/react-tooltip",
      ],
    },
  },

  server: {
    hmr: {
      port: 8002,
    },
    port: Number(process.env.PORT),
  },

  plugins: [
    expressDevServer({
      exportName: "express",
    }),
    remix({
      ignoredRouteFiles: ["**/.*"],
      serverModuleFormat: "esm",
    }),
    tsconfigPaths(),
  ],
});
