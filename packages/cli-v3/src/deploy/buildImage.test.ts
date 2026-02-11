import { describe, it, expect } from "vitest";
import { generateContainerfile, GenerateContainerfileOptions } from "./buildImage.js";

describe("generateContainerfile", () => {
    const baseOptions: GenerateContainerfileOptions = {
        runtime: "node-22",
        build: {
            env: {},
            commands: [],
        },
        image: {
            pkgs: [],
            instructions: [],
        },
        indexScript: "index.js",
        entrypoint: "entrypoint.js",
    };

    it("should include ARG SOURCE_DATE_EPOCH", async () => {
        const result = await generateContainerfile(baseOptions);
        expect(result).toContain("ARG SOURCE_DATE_EPOCH");
    });

    it("should generate npm ci command when package-lock.json is present", async () => {
        const result = await generateContainerfile({
            ...baseOptions,
            lockfile: "package-lock.json",
        });
        expect(result).toContain("COPY --chown=node:node package.json package-lock.json ./");
        expect(result).toContain("RUN npm ci --no-audit --no-fund");
    });

    it("should generate bun install --frozen-lockfile command when bun.lockb is present", async () => {
        const result = await generateContainerfile({
            ...baseOptions,
            runtime: "bun",
            lockfile: "bun.lockb",
        });
        expect(result).toContain("COPY --chown=bun:bun package.json bun.lockb ./");
        expect(result).toContain("RUN bun install --frozen-lockfile --production");
    });

    it("should generate pnpm install command and copy pnpm-lock.yaml", async () => {
        const result = await generateContainerfile({
            ...baseOptions,
            packageManager: "pnpm",
            lockfile: "pnpm-lock.yaml",
        });
        expect(result).toContain("COPY --chown=node:node package.json pnpm-lock.yaml ./");
        expect(result).toContain("RUN npx pnpm i --prod --no-frozen-lockfile");
    });

    it("should generate npm install command by default", async () => {
        const result = await generateContainerfile(baseOptions);
        expect(result).toContain("RUN npm i --no-audit --no-fund --no-save --no-package-lock");
    });

    it("should generate npm install command when npm is specified", async () => {
        const result = await generateContainerfile({
            ...baseOptions,
            packageManager: "npm",
        });
        expect(result).toContain("RUN npm i --no-audit --no-fund --no-save --no-package-lock");
    });

    it("should generate pnpm install command when pnpm is specified", async () => {
        const result = await generateContainerfile({
            ...baseOptions,
            packageManager: "pnpm",
        });
        expect(result).toContain("RUN npx pnpm i --prod --no-frozen-lockfile");
    });

    it("should generate yarn install command when yarn is specified", async () => {
        const result = await generateContainerfile({
            ...baseOptions,
            packageManager: "yarn",
        });
        expect(result).toContain("RUN yarn install --production --no-lockfile");
    });
});
