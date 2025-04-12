import { logger, task } from "@trigger.dev/sdk/v3";
import { randomUUID } from "crypto";
import { ElevenLabsClient } from "elevenlabs";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const eleventLabs = new ElevenLabsClient();
const s3 = new S3Client({
  forcePathStyle: false,
});

export const createAudioStreamFromText = async (text: string): Promise<Buffer> => {
  const audioStream = await eleventLabs.textToSpeech.convertAsStream("M6N6IdXhi5YNZyZSDe7k", {
    model_id: "eleven_multilingual_v2",
    text,
    output_format: "mp3_44100_128",
    voice_settings: {
      stability: 0,
      similarity_boost: 1.0,
      use_speaker_boost: true,
      speed: 1.0,
    },
  });
  const chunks: Buffer[] = [];
  for await (const chunk of audioStream) {
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks);
  return content;
};

export const generatePresignedUrl = async (objectKey: string, bucket: string) => {
  const getObjectParams = {
    Bucket: bucket,
    Key: objectKey,
    Expires: 3600,
  };
  const command = new GetObjectCommand(getObjectParams);
  const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
  return url;
};

export const uploadAudioStreamToS3 = async (audioStream: Buffer, bucket: string) => {
  const remotePath = `${randomUUID()}.mp3`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: remotePath,
      Body: audioStream,
      ContentType: "audio/mpeg",
    })
  );
  return remotePath;
};

export const convertTextToSpeech = task({
  id: "convert-text-to-speech",
  maxDuration: 300,
  run: async (payload: { text: string }) => {
    const bucket = process.env.AWS_S3_BUCKET;
    if (!bucket) {
      throw new Error("AWS_S3_BUCKET is not set");
    }

    const audioStream = await createAudioStreamFromText(payload.text);
    logger.info("Audio stream created");

    const s3path = await uploadAudioStreamToS3(audioStream, bucket);
    logger.info("Audio stream uploaded to S3");

    const audioUrl = await generatePresignedUrl(s3path, bucket);
    logger.info("Audio URL generated");

    return {
      audioUrl,
    };
  },
});
