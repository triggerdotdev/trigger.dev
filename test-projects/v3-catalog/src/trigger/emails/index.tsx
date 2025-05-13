import { Button, Html } from "@react-email/components";
import * as React from "react";

export function ExampleEmail(props: {}) {
  return (
    <Html>
      <Button
        href="https://example.com"
        style={{ background: "#000", color: "#fff", padding: "12px 20px" }}
      >
        Click me
      </Button>
    </Html>
  );
}
