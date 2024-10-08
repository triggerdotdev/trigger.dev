import { Hr, Link, Text } from "@react-email/components";
import React from "react";
import { footer, footerAnchor, hr } from "./styles";

export function Footer() {
  return (
    <>
      <Hr style={hr} />
      <Text style={footer}>
        ©Trigger.dev, 1111B S Governors Ave STE 6433, Dover, DE 19904 |{" "}
        <Link style={footerAnchor} href="https://trigger.dev/">
          Trigger.dev
        </Link>
      </Text>
    </>
  );
}
