export interface Ratelimit {
  /*
   * The ratelimit function
   * @param {RatelimitOptions} options
   * @returns {Promise<RatelimitResponse>}
   */
  limit: (options: RatelimitOptions) => Promise<RatelimitResponse>;
}

export interface RatelimitOptions {
  /*
   * The key to identify the user, can be an IP address, user ID, etc.
   */
  key: string;
}

export interface RatelimitResponse {
  /*
   * The ratelimit success status
   * @returns {boolean}
   */
  success: boolean;
}
