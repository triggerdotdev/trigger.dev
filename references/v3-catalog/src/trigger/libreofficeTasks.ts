import { task } from "@trigger.dev/sdk/v3";
import { convert } from "libreoffice-convert";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "auto",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

// Function to download a file
const downloadFile = async (url: string, outputPath: string): Promise<void> => {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(buffer));
  console.log(`Downloaded file to ${outputPath}`);
};

// Function to upload a file to s3 bucket
const uploadToS3 = async (file_path: string, key: string): Promise<void> => {
  const bucketName = process.env.S3_BUCKET_NAME;
  if (!bucketName) {
    throw new Error("S3_BUCKET_NAME environment variable is not set");
  }

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: fs.readFileSync(file_path),
    ContentType: "application/pdf",
  });

  try {
    await s3Client.send(command);
  } catch (error) {
    console.error("Error uploading to S3:", error);
    throw error;
  }
};

export const libreofficeConvertAndUploadToS3 = task({
  id: "libreoffice-convert-and-upload-to-s3",
  run: async ({ file_url }: { file_url: string | undefined }) => {
    const convertAsync = promisify(convert);

    const docUrl = file_url || "https://filesamples.com/samples/document/docx/sample3.docx";
    const docxPath = path.join(process.cwd(), "sample.docx");
    let pdfPath = "";

    try {
      // Step 1: Download the .docx file
      await downloadFile(docUrl, docxPath);

      // Step 2: Convert the downloaded .docx file to .pdf
      const docxFile = fs.readFileSync(docxPath);
      const pdfBuffer = await convertAsync(docxFile, ".pdf", undefined);
      pdfPath = path.join(process.cwd(), "libre-docx-to-pdf-for-s3.pdf");
      fs.writeFileSync(pdfPath, pdfBuffer);

      // Step 3: Upload the converted PDF to S3
      const s3Key = `converted-docs/${Date.now()}-output.pdf`;
      await uploadToS3(pdfPath, s3Key);

      console.log(`File converted and uploaded to S3: ${s3Key}`);
    } finally {
      // Clean up local files
      if (fs.existsSync(docxPath)) {
        fs.unlinkSync(docxPath);
      }
      if (fs.existsSync(pdfPath)) {
        fs.unlinkSync(pdfPath);
      }
      console.log("Cleaned local files");
    }
  },
  retry: {
    maxAttempts: 2,
  },
});