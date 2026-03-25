import { ECRClient, GetAuthorizationTokenCommand } from "@aws-sdk/client-ecr";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { tryCatch } from "@trigger.dev/core";
import Docker from "dockerode";

interface ECRTokenCache {
  token: string;
  username: string;
  serverAddress: string;
  expiresAt: Date;
}

export class ECRAuthService {
  private readonly logger = new SimpleStructuredLogger("ecr-auth-service");
  private readonly ecrClient: ECRClient;
  private tokenCache: ECRTokenCache | null = null;

  constructor() {
    this.ecrClient = new ECRClient();

    this.logger.info("🔐 ECR Auth Service initialized", {
      region: this.ecrClient.config.region,
    });
  }

  /**
   * Check if we have AWS credentials configured
   */
  static hasAWSCredentials(): boolean {
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      return true;
    }

    if (
      process.env.AWS_PROFILE ||
      process.env.AWS_ROLE_ARN ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE
    ) {
      return true;
    }

    return false;
  }

  /**
   * Check if the current token is still valid with a 10-minute buffer
   */
  private isTokenValid(): boolean {
    if (!this.tokenCache) {
      return false;
    }

    const now = new Date();
    const bufferMs = 10 * 60 * 1000; // 10 minute buffer before expiration
    return now < new Date(this.tokenCache.expiresAt.getTime() - bufferMs);
  }

  /**
   * Get a fresh ECR authorization token from AWS
   */
  private async fetchNewToken(): Promise<ECRTokenCache | null> {
    const [error, response] = await tryCatch(
      this.ecrClient.send(new GetAuthorizationTokenCommand({}))
    );

    if (error) {
      this.logger.error("Failed to get ECR authorization token", { error });
      return null;
    }

    const authData = response.authorizationData?.[0];
    if (!authData?.authorizationToken || !authData.proxyEndpoint) {
      this.logger.error("Invalid ECR authorization response", { authData });
      return null;
    }

    // Decode the base64 token to get username:password
    const decoded = Buffer.from(authData.authorizationToken, "base64").toString("utf-8");
    const [username, password] = decoded.split(":", 2);

    if (!username || !password) {
      this.logger.error("Failed to parse ECR authorization token");
      return null;
    }

    const expiresAt = authData.expiresAt || new Date(Date.now() + 12 * 60 * 60 * 1000); // Default 12 hours

    const tokenCache: ECRTokenCache = {
      token: password,
      username,
      serverAddress: authData.proxyEndpoint,
      expiresAt,
    };

    this.logger.info("🔐 Successfully fetched ECR token", {
      username,
      serverAddress: authData.proxyEndpoint,
      expiresAt: expiresAt.toISOString(),
    });

    return tokenCache;
  }

  /**
   * Get ECR auth config for Docker operations
   * Returns cached token if valid, otherwise fetches a new one
   */
  async getAuthConfig(): Promise<Docker.AuthConfig | null> {
    // Check if cached token is still valid
    if (this.isTokenValid()) {
      this.logger.debug("Using cached ECR token");
      return {
        username: this.tokenCache!.username,
        password: this.tokenCache!.token,
        serveraddress: this.tokenCache!.serverAddress,
      };
    }

    // Fetch new token
    this.logger.info("Fetching new ECR authorization token");
    const newToken = await this.fetchNewToken();

    if (!newToken) {
      return null;
    }

    // Cache the new token
    this.tokenCache = newToken;

    return {
      username: newToken.username,
      password: newToken.token,
      serveraddress: newToken.serverAddress,
    };
  }

  /**
   * Clear the cached token (useful for testing or forcing refresh)
   */
  clearCache(): void {
    this.tokenCache = null;
    this.logger.debug("ECR token cache cleared");
  }
}
