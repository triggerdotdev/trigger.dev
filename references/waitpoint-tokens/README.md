# An AI workflow with a human-in-the-loop approval step

This reference project shows a possible approach to implement workflows using Trigger.dev and [ReactFlow](https://reactflow.dev/).
It makes use of the Trigger.dev Realtime API and the new waitpoint token feature to implement a human-in-the-loop workflow.

## Getting Started

This guide assumes that you have followed the [Contributing.md](https://github.com/triggerdotdev/trigger.dev/blob/main/CONTRIBUTING.md#setup) instructions to set up a local Trigger.dev instance. If not, please complete the setup before continuing.

1. Run the main Trigger.dev webapp:

    ```bash
    pnpm run dev --filter webapp
    ```

2. Optionally, build the CLI and SDK if you are working on them and applying changes:

    ```bash
    pnpm run dev --filter trigger.dev --filter "@trigger.dev/*"
    ```

3. Login with the CLI:

    ```bash
    cd references/trigger-flow
    pnpm exec trigger login -a http://localhost:3030
    ```

    Optionally, you can use the `profile` flag to create a new profile:

    ```bash
    pnpm exec trigger login -a http://localhost:3030 --profile local
    ```

    Note that you'll need to use this profile for the subsequent commands.

4. Create an `.env` file by copying [.env.example](.env.example) and fill in the required environment variables. The example file includes a description for each variable.

5. Run the CLI

    ```bash
    pnpm exec trigger dev
    ```

    You should see now the `dev` command spitting out messages, including that it's started a background worker.

6. Run the ReactFlow app:

    ```bash
    pnpm run dev
    ```

    Open [http://localhost:3000](http://localhost:3000) on your browser to checkout the workflow.

## Learn More

To learn more about the technologies used in this project, check out the following resources:

- [Trigger.dev Docs](https://trigger.dev/docs) - learn about Trigger.dev and its features
- [Trigger.dev Waitpoint Token Docs](https://trigger.dev/docs/wait-for-token) - learn about waitpoint tokens in Trigger.dev and human-in-the-loop flows
- [Trigger.dev Realtime Docs](https://trigger.dev/docs/realtime) - learn about the Realtime feature of Trigger.dev
- [Trigger.dev Realtime Streams](https://trigger.dev/docs/realtime/streams) - learn about the different types of streams available in Trigger.dev
- [ReactFlow Docs](https://reactflow.dev/learn) - learn about building interactive diagrams using ReactFlow
- [React Hooks for Trigger.dev](https://trigger.dev/docs/frontend/react-hooks) - learn about the React hooks provided by Trigger.dev
- [ElevenLabs SDK](https://elevenlabs.io/docs/overview) - learn about ElevenLabs' AI audio capabilities
- [AI SDK Documentation](https://sdk.vercel.ai/docs/introduction) - learn about the AI SDK for working with LLMs
