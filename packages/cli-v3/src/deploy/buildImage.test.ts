import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildImage } from "./buildImage.js";
import { x } from "tinyexec";

// Mock tinyexec
vi.mock("tinyexec", () => ({
    x: vi.fn(),
}));

describe("buildImage", () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it("should login to Docker Hub if DOCKER_USERNAME and DOCKER_PASSWORD are set", async () => {
        process.env.DOCKER_USERNAME = "testuser";
        process.env.DOCKER_PASSWORD = "testpassword";

        // x returns a promise-like object that is also an async iterable
        // and has a .process property
        const mockProcess = {
            process: {
                stdin: {
                    write: vi.fn(),
                    end: vi.fn(),
                },
            },
            exitCode: 0,
            [Symbol.asyncIterator]: async function* () {
                yield "Login Succeeded\n";
            },
            then: (resolve: any) => resolve({ exitCode: 0 }), // Make it thenable
        };

        (x as any).mockReturnValue(mockProcess);

        await buildImage({
            isLocalBuild: true,
            imagePlatform: "linux/amd64",
            compilationPath: "/tmp/test",
            deploymentId: "dep_123",
            deploymentVersion: "v1",
            imageTag: "trigger.dev/test:v1",
            projectId: "proj_123",
            projectRef: "ref_123",
            contentHash: "hash_123",
            apiKey: "key_123",
            apiUrl: "https://api.trigger.dev",
            apiClient: {
                getRemoteBuildProviderStatus: vi.fn().mockResolvedValue({ success: true, data: { status: "operational" } }),
            } as any,
            builder: "trigger",
            authAccessToken: "token",
        });

        // Verify docker login was called
        expect(x).toHaveBeenCalledWith(
            "docker",
            ["login", "--username", "testuser", "--password-stdin"],
            expect.objectContaining({
                nodeOptions: { cwd: "/tmp/test" },
            })
        );

        // Verify password was written to stdin
        expect(mockProcess.process.stdin.write).toHaveBeenCalledWith("testpassword");
        expect(mockProcess.process.stdin.end).toHaveBeenCalled();

        // Verify docker logout was called
        expect(x).toHaveBeenCalledWith("docker", ["logout"]);
    });

    it("should NOT login to Docker Hub if credentials are missing", async () => {
        delete process.env.DOCKER_USERNAME;
        delete process.env.DOCKER_PASSWORD;

        const mockProcess = {
            process: { stdin: { write: vi.fn(), end: vi.fn() } },
            exitCode: 0,
            [Symbol.asyncIterator]: async function* () { },
            then: (resolve: any) => resolve({ exitCode: 0 }),
        };
        (x as any).mockReturnValue(mockProcess);

        await buildImage({
            isLocalBuild: true,
            imagePlatform: "linux/amd64",
            compilationPath: "/tmp/test",
            deploymentId: "dep_123",
            deploymentVersion: "v1",
            imageTag: "trigger.dev/test:v1",
            projectId: "proj_123",
            projectRef: "ref_123",
            contentHash: "hash_123",
            apiKey: "key_123",
            apiUrl: "https://api.trigger.dev",
            apiClient: {
                getRemoteBuildProviderStatus: vi.fn().mockResolvedValue({ success: true, data: { status: "operational" } }),
            } as any,
            builder: "trigger",
            authAccessToken: "token",
        });

        const loginCalls = (x as any).mock.calls.filter((call: any[]) =>
            call[0] === "docker" && call[1].includes("login") && call[1].includes("--username")
        );
        expect(loginCalls.length).toBe(0);
    });
});
