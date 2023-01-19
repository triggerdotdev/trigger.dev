import React from "react";
import { Hr } from "@react-email/hr";
import { Link } from "@react-email/link";
import { Text } from "@react-email/text";
import { anchor, footer, footerAnchor, hr } from "./styles";

export function Footer() {
  return (
    <>
      <Hr style={hr} />
      <Text style={footer}>
        <Link style={footerAnchor} href="https://app.trigger.dev/">
          Trigger.dev
        </Link>
        . ©Trigger.dev, 2261 Market Street #4968, San Francisco, CA 94114
      </Text>
    </>
  );
}
