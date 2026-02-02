
import { describe, it, expect } from "vitest";
import { generateContainerfile, GenerateContainerfileOptions } from "./buildImage.js";

describe("generateContainerfile", () => {
    const defaultOptions: GenerateContainerfileOptions = {
        runtime: "node",
        build: {
            env: {},
        },
        image: {},
        indexScript: "index.js",
        entrypoint: "entrypoint.js",
    };

    it("should generate npm install command by default", async () => {
        const dockerfile = await generateContainerfile(defaultOptions);
        expect(dockerfile).toContain("COPY --chown=node:node package.json ./");
        expect(dockerfile).toContain("RUN npm i --no-audit --no-fund --no-save --no-package-lock");
    });

    it("should generate yarn install command when packageManager is yarn", async () => {
        const options: GenerateContainerfileOptions = {
            ...defaultOptions,
            packageManager: { name: "yarn", command: "yarn", version: "1.22.19" },
        };
        const dockerfile = await generateContainerfile(options);
        expect(dockerfile).toContain("RUN yarn install");
    });

    it("should generate pnpm install command when packageManager is pnpm", async () => {
        const options: GenerateContainerfileOptions = {
            ...defaultOptions,
            packageManager: { name: "pnpm", command: "pnpm", version: "8.6.0" },
        };
        const dockerfile = await generateContainerfile(options);
        expect(dockerfile).toContain("RUN corepack enable");
        expect(dockerfile).toContain("RUN pnpm install");
    });

    it("should copy lockfile if provided", async () => {
        const options: GenerateContainerfileOptions = {
            ...defaultOptions,
            packageManager: { name: "yarn", command: "yarn", version: "1.22.19" },
            lockfilePath: "yarn.lock",
        };
        const dockerfile = await generateContainerfile(options);
        expect(dockerfile).toContain("COPY --chown=node:node yarn.lock ./");
    });
});
