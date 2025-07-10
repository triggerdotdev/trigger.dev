import { Body, Container, Head, Html, Preview, Section, Text } from "@react-email/components";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import { container, h1, main, paragraphLight } from "./components/styles";
import { z } from "zod";

export const BulkActionCompletedEmailSchema = z.object({
  email: z.literal("bulk-action-completed"),
  bulkActionId: z.string(),
  url: z.string().url(),
  totalCount: z.number(),
  successCount: z.number(),
  failureCount: z.number(),
  type: z.enum(["CANCEL", "REPLAY"]),
});

type BulkActionCompletedEmailProps = z.infer<typeof BulkActionCompletedEmailSchema>;

const previewDefaults: BulkActionCompletedEmailProps = {
  email: "bulk-action-completed",
  bulkActionId: "123",
  url: "http://localhost:3000/bulk-actions/123",
  totalCount: 100,
  successCount: 90,
  failureCount: 10,
  type: "CANCEL",
};

export default function Email(props: BulkActionCompletedEmailProps) {
  const { bulkActionId, url, totalCount, successCount, failureCount, type } = {
    ...previewDefaults,
    ...props,
  };

  return (
    <Html>
      <Head />
      <Preview>Bulk action {bulkActionId} completed</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={h1}>Bulk action {bulkActionId} finished.</Text>
          <Text style={paragraphLight}>You bulk action finished processing:</Text>

          <Text style={paragraphLight}>
            Successfully {pastTense(type)}: {totalCount} runs.
          </Text>
          <Text style={paragraphLight}>
            Failed to {type.toLocaleLowerCase()}: {failureCount} runs.
          </Text>
          <Image path="/emails/logo-mono.png" width="120" height="22" alt="Trigger.dev" />
          <Footer />
        </Container>
      </Body>
    </Html>
  );
}

function pastTense(type: "CANCEL" | "REPLAY") {
  switch (type) {
    case "CANCEL":
      return "canceled";
    case "REPLAY":
      return "replayed";
  }
}
