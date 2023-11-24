import { Hr } from "@react-email/hr";
import { Link } from "@react-email/link";
import { Text } from "@react-email/text";
import React from "react";
import { footer, footerAnchor, hr } from "./styles";

export function Footer() {
  return (
    <>
      <Hr style={hr} />
      <Text style={footer}>
        <Link style={footerAnchor} href="https://trigger.dev/">
          Trigger.dev
        </Link>
        . ©Trigger.dev, 1111B S Governors Ave STE 6433, Dover, DE 19904
      </Text>
    </>
  );
}
