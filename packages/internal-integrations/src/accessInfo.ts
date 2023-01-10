import { AccessInfo } from "./types";

export function getAccessToken(accessInfo: AccessInfo): string {
  switch (accessInfo.type) {
    case "oauth2": {
      return accessInfo.accessToken;
    }
    case "api_key": {
      return accessInfo.api_key;
    }
  }
}
