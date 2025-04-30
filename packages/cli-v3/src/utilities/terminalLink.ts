/*
    MIT License
    Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
    Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
    The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

import ansiEscapes from "ansi-escapes";
import supportsHyperlinks from "./supportsHyperlinks.js";

export type TerminalLinkOptions = {
  /**
    Override the default fallback. If false, the fallback will be disabled.
    @default `${text} (${url})`
  */
  readonly fallback?: ((text: string, url: string) => string) | boolean;
};

/**
    Create a clickable link in the terminal's stdout.

    [Supported terminals.](https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda)
    For unsupported terminals, the link will be printed in parens after the text: `My website (https://sindresorhus.com)`,
    unless the fallback is disabled by setting the `fallback` option to `false`.

    @param text - Text to linkify.
    @param url - URL to link to.

    @example
    ```
    import terminalLink from 'terminal-link';

    const link = terminalLink('My Website', 'https://sindresorhus.com');
    console.log(link);
    ```

    @deprecated The default fallback is broken in some terminals. Please use `cliLink` instead.
*/
function terminalLink(
  text: string,
  url: string,
  { target = "stdout", ...options }: { target?: "stdout" | "stderr" } & TerminalLinkOptions = {}
) {
  if (!supportsHyperlinks[target]) {
    // If the fallback has been explicitly disabled, don't modify the text itself.
    if (options.fallback === false) {
      return text;
    }

    return typeof options.fallback === "function"
      ? options.fallback(text, url)
      : `${text} (\u200B${url}\u200B)`;
  }

  return ansiEscapes.link(text, url);
}
/**
    Check whether the terminal supports links.

    Prefer just using the default fallback or the `fallback` option whenever possible.
*/
terminalLink.isSupported = supportsHyperlinks.stdout;
terminalLink.stderr = terminalLinkStderr;

/**
    Create a clickable link in the terminal's stderr.

    [Supported terminals.](https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda)
    For unsupported terminals, the link will be printed in parens after the text: `My website (https://sindresorhus.com)`.

    @param text - Text to linkify.
    @param url - URL to link to.

    @example
    ```
    import terminalLink from 'terminal-link';

    const link = terminalLink.stderr('My Website', 'https://sindresorhus.com');
    console.error(link);
    ```
*/
function terminalLinkStderr(text: string, url: string, options: TerminalLinkOptions = {}) {
  return terminalLink(text, url, { target: "stderr", ...options });
}

/**
    Check whether the terminal's stderr supports links.

    Prefer just using the default fallback or the `fallback` option whenever possible.
*/
terminalLinkStderr.isSupported = supportsHyperlinks.stderr;

export { terminalLink };
