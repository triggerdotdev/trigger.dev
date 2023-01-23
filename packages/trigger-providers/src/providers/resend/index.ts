import * as schemas from "./schemas";

export const resend = {
  name: "Resend",
  slug: "resend",
  icon: "/integrations/resend.png",
  enabledFor: "all",
  authentication: {
    type: "api_key",
    header_name: "Authorization",
    header_type: "access_token",
    documentation: `1. Login to [Resend](https://resend.com)`,
  },
  schemas,
};
