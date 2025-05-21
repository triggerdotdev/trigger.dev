import { task } from "@trigger.dev/sdk/v3";
import ffmpeg from "fluent-ffmpeg";
import * as path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";

import bcrypt from "bcrypt";

const saltRounds = 10;
const myPlaintextPassword = "s0//P4$$w0rD";
const someOtherPlaintextPassword = "not_bacon";

bcrypt.genSalt(saltRounds, function (err, salt) {
  bcrypt.hash(myPlaintextPassword, salt, function (err, hash) {
    // Store hash in your password DB.
  });
});

import { InfisicalClient } from "@infisical/sdk";

const infisicalClient = new InfisicalClient({
  siteUrl: "https://example.com",
});

import * as mupdf from "mupdf";

// Helper function to load document from URL
async function loadDocumentFromUrl(url: string): Promise<mupdf.Document> {
  try {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    return mupdf.Document.openDocument(buffer, "application/pdf");
  } catch (error) {
    throw new Error(`Failed to load document from URL: ${url}`);
  }
}

import zip from "zip-node-addon";

function unzip(inputPath: string, outputPath: string) {
  zip.unzipFile(inputPath, outputPath);
}

import { createClient } from "@1password/sdk";

// Creates an authenticated client.
const client = await createClient({
  auth: process.env.OP_SERVICE_ACCOUNT_TOKEN ?? "",
  // Set the following to your own integration name and version.
  integrationName: "My 1Password Integration",
  integrationVersion: "v1.0.0",
});

// Fetches a secret.
// const secret = await client.secrets.resolve("op://vault/item/field");

import sharp from "sharp";
import sqlite3 from "sqlite3";
import { createCanvas } from "canvas";

// Test sharp: create a 1x1 PNG buffer
const sharpBufferPromise = sharp({
  create: {
    width: 1,
    height: 1,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .png()
  .toBuffer();

// Test sqlite3: open an in-memory database
const sqliteDb = new sqlite3.Database(":memory:", (err) => {
  if (err) {
    console.error("sqlite3 error:", err);
  } else {
    console.log("sqlite3 in-memory database opened");
  }
});

// Test canvas: create a 100x100 canvas and draw a rectangle
const canvas = createCanvas(100, 100);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "red";
ctx.fillRect(10, 10, 80, 80);

export const convertVideo = task({
  id: "convert-video",
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000,
    factor: 2,
  },
  run: async ({ url }: { url: string }) => {
    const outputPath = path.join("/tmp", `output_${Date.now()}.mp4`);

    const response = await fetch(url);

    await new Promise((resolve, reject) => {
      ffmpeg(Readable.fromWeb(response.body as ReadableStream))
        .videoFilters("scale=iw/2:ih/2")
        .output(outputPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    console.log(`Video converted to ${outputPath}`);

    return { success: true, outputPath };
  },
});
