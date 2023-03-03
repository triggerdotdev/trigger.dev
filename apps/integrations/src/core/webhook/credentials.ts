import { AuthCredentials } from "core/authentication/types";
import { WebhookAuthentication } from "./subscribe/types";
import { Nango } from "@nangohq/node";
import { Service } from "core/service/types";

const nango = new Nango({
  host: process.env.NANGO_HOST,
  secretKey: process.env.NANGO_SECRET_KEY,
});

export async function getCredentials({
  service,
  authentication,
}: {
  service: Service;
  authentication: WebhookAuthentication;
}): Promise<AuthCredentials | undefined> {
  switch (authentication.type) {
    case "oauth": {
      try {
        const accessToken = await nango.getToken(
          service.service,
          authentication.connectionId
        );
        if (accessToken == null) {
          return undefined;
        }

        const serviceAuthentication = Object.entries(
          service.authentication
        ).find(([name, info]) => info.type === "oauth2");
        if (!serviceAuthentication) {
          console.error("Service does not support oauth2");
          return undefined;
        }

        const [authName, authInfo] = serviceAuthentication;

        //todo if it's an OAuth1 API then this will fail, as Pizzly returns an object
        return {
          type: "oauth2",
          accessToken,
          name: authName,
          scopes: Object.keys(authInfo.scopes),
        };
      } catch (e) {
        console.log("PIZZLY_ACCESS_TOKEN_FAILED");
        console.error(e);
        return undefined;
      }
    }
    case "api-key": {
      const serviceAuthentication = Object.entries(service.authentication).find(
        ([name, info]) => info.type === "oauth2"
      );
      if (!serviceAuthentication) {
        console.error("Service does not support oauth2");
        return undefined;
      }

      const [authName, authInfo] = serviceAuthentication;

      return {
        type: "api_key",
        api_key: authentication.api_key,
        name: authName,
        scopes: Object.keys(authInfo.scopes),
      };
    }
    default: {
      throw new Error("Unsupported authentication method");
    }
  }
}
