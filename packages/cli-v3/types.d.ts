declare module "terminal-link" {
  export interface Options {
    fallback?: ((text: string, url: string) => string) | boolean;
  }

  /**
   * @deprecated The default fallback is broken in some terminals. Please use `cliLink` instead.
   */
  export default function terminalLink(text: string, url: string, options?: Options): string;
}
