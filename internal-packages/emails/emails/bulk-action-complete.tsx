import {
  Body,
  Column,
  Container,
  Head,
  Html,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from "@react-email/components";
import { Footer } from "./components/Footer";
import { Image } from "./components/Image";
import {
  anchor,
  bullets,
  container,
  grey,
  h1,
  main,
  paragraphLight,
  sans,
} from "./components/styles";
import { z } from "zod";
import { Button } from "@react-email/components";

export const BulkActionCompletedEmailSchema = z.object({
  email: z.literal("bulk-action-completed"),
  bulkActionId: z.string(),
  url: z.string().url(),
  totalCount: z.number(),
  successCount: z.number(),
  failureCount: z.number(),
  createdAt: z.string(),
  completedAt: z.string(),
  type: z.enum(["CANCEL", "REPLAY"]),
});

type BulkActionCompletedEmailProps = z.infer<typeof BulkActionCompletedEmailSchema>;

const previewDefaults: BulkActionCompletedEmailProps = {
  email: "bulk-action-completed",
  bulkActionId: "bulk_cmcxgmhjn0001cw7ct7g936uz",
  url: "http://localhost:3000/bulk-actions/123",
  totalCount: 100,
  successCount: 90,
  failureCount: 10,
  type: "CANCEL",
  createdAt: "10 Jul 2025, 15:04:04",
  completedAt: "10 Jul 2025, 15:05:04",
};

export default function Email(props: BulkActionCompletedEmailProps) {
  const {
    bulkActionId,
    url,
    totalCount,
    successCount,
    failureCount,
    type,
    createdAt,
    completedAt,
  } = {
    ...previewDefaults,
    ...props,
  };

  return (
    <Html>
      <Head />
      <Preview>Bulk action {bulkActionId} finished.</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={h1}>Bulk action finished</Text>
          <Text style={paragraphLight}>Here's a summary of your bulk action:</Text>

          <Property label="ID" value={bulkActionId} />
          <Property label="Started" value={`${createdAt} (UTC)`} />
          <Property label="Completed" value={`${completedAt} (UTC)`} />
          <Property label={`Successfully ${pastTense(type)}`} value={`${successCount} runs`} />
          <Property
            label={`Failed to ${type.toLocaleLowerCase()}`}
            value={`${failureCount} runs`}
          />
          <Property label="Total runs" value={`${totalCount} runs`} />

          <Button
            style={{
              ...sans,
              boxSizing: "border-box",
              padding: "12px 24px",
              borderRadius: "8px",
              backgroundColor: "#615FFF",
              textAlign: "center",
              fontWeight: "600",
              color: "#ffffff",
              marginTop: "24px",
              marginBottom: "32px",
            }}
            href={url}
          >
            View bulk action
          </Button>
          <Image path="/emails/logo-mono.png" width="120" height="22" alt="Trigger.dev" />
          <Footer />
        </Container>
      </Body>
    </Html>
  );
}

function Property({ label, value }: { label: string; value: string | number }) {
  return (
    <Row>
      <Column align="left" style={{ ...bullets, width: "33%" }}>
        {label}
      </Column>
      <Column align="left" style={{ ...bullets, ...grey, width: "66%" }}>
        {value}
      </Column>
    </Row>
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
