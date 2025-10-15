import { sandbox, task } from "@trigger.dev/sdk";

export const helloWorldSandbox = sandbox.define({
  id: "hello-world-sandbox-2",
  packages: ["sharp"],
  systemPackages: [],
  runtime: "node:22",
});

export const helloWorldSandboxTask = task({
  id: "hello-world-sandbox-task",
  run: async (payload: any, { ctx }) => {
    // Dynamically generate a simple image using sharp and return it as a base64 string
    const result = await helloWorldSandbox.runCodeAndWait<string>({
      entry: "index.ts#main",
      input: {
        width: 32,
        height: 32,
        colors: [
          [255, 0, 0], // Red
          [0, 255, 0], // Green
          [0, 0, 255], // Blue
          [255, 255, 0], // Yellow
          [255, 255, 255], // White
        ],
      },
      files: [
        {
          path: "index.ts",
          content: `
            import sharp from 'sharp';

            type RGB = [number, number, number];

            export async function main({ width = 32, height = 32, colors }: { width: number, height: number, colors?: RGB[] }) {
              const defaultColors: RGB[] = [
                [255, 0, 0],   // Red
                [0, 255, 0],   // Green
                [0, 0, 255],   // Blue
                [255, 255, 0], // Yellow
                [255, 255, 255] // White
              ];
              
              const selectedColors = colors || defaultColors;
              const channels = 3; // RGB
              const buffer = Buffer.alloc(width * height * channels);
              
              // Generate random pixel data
              for (let i = 0; i < buffer.length; i += channels) {
                const color = selectedColors[Math.floor(Math.random() * selectedColors.length)];
                buffer[i] = color[0];     // R
                buffer[i + 1] = color[1]; // G
                buffer[i + 2] = color[2]; // B
              }
              
              // Convert to PNG and get base64
              const pngBuffer = await sharp(buffer, {
                raw: {
                  width: width,
                  height: height,
                  channels: 3
                }
              })
              .png()
              .toBuffer();
              
              return pngBuffer.toString('base64');
            }
          `,
        },
      ],
    });

    if (result.ok) {
      console.log(result.output);
    }

    return result;
  },
});
