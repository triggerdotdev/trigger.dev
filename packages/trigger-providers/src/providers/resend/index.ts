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
    documentation: `1. Login to [Resend](https://resend.com)
2. Go to the API Keys page
3. Generate a new API key
4. Paste it into the field below`,
  },
  schemas,
};
