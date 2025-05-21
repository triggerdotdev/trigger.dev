/*
    MIT License

    Copyright (c) Microsoft Corporation.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE
 */

type Transform = (str: string) => string;

interface Options {
  /**
   * Limit the length of the input string. Useful when the input string is generated or your application allows
   * users to pass a string, et cetera.
   *
   * @default 65536
   * @example
   * console.log(braces('a/{b,c}/d', { maxLength: 3 }));
   * //=> throws an error
   */
  maxLength?: number | undefined;
  /**
   * Generate an "expanded" brace pattern (alternatively you can use the `braces.expand()` method).
   *
   * @default undefined
   * @example
   * console.log(braces('a/{b,c}/d', { expand: true }));
   * //=> [ 'a/b/d', 'a/c/d' ]
   */
  expand?: boolean | undefined;
  /**
   * Remove duplicates from the returned array.
   *
   * @default undefined
   */
  nodupes?: boolean | undefined;
  /**
   * To prevent malicious patterns from being passed by users, an error is thrown when `braces.expand()`
   * is used or `options.expand` is true and the generated range will exceed the `rangeLimit`.
   *
   * You can customize `options.rangeLimit` or set it to `Infinity` to disable this altogether.
   *
   * @default 1000
   * @example
   * // pattern exceeds the "rangeLimit", so it's optimized automatically
   * console.log(braces.expand('{1..1000}'));
   * //=> ['([1-9]|[1-9][0-9]{1,2}|1000)']
   *
   * // pattern does not exceed "rangeLimit", so it's NOT optimized
   * console.log(braces.expand('{1..100}'));
   * //=> ['1', '2', '3', '4', '5', …, '100']
   */
  rangeLimit?: number | undefined;
  /**
   * Customize range expansion.
   *
   * @default undefined
   * @example
   * const range = braces.expand('x{a..e}y', {
   *   transform: (str) => `foo/${str}`
   * });
   *
   * console.log(range);
   * //=> [ 'xfooay', 'xfooby', 'xfoocy', 'xfoody', 'xfooey' ]
   */
  transform?: Transform | undefined;
  /**
   * In regular expressions, quanitifiers can be used to specify how many times a token can be repeated.
   * For example, `a{1,3}` will match the letter `a` one to three times.
   *
   * Unfortunately, regex quantifiers happen to share the same syntax as [Bash lists](#lists)
   *
   * The `quantifiers` option tells braces to detect when [regex quantifiers](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp#quantifiers)
   * are defined in the given pattern, and not to try to expand them as lists.
   *
   * @default undefined
   * @example
   * const braces = require('braces');
   * console.log(braces('a/b{1,3}/{x,y,z}'));
   * //=> [ 'a/b(1|3)/(x|y|z)' ]
   * console.log(braces('a/b{1,3}/{x,y,z}', {quantifiers: true}));
   * //=> [ 'a/b{1,3}/(x|y|z)' ]
   * console.log(braces('a/b{1,3}/{x,y,z}', {quantifiers: true, expand: true}));
   * //=> [ 'a/b{1,3}/x', 'a/b{1,3}/y', 'a/b{1,3}/z' ]
   */
  quantifiers?: boolean | undefined;
  /**
   * Do not strip backslashes that were used for escaping from the result.
   *
   * @default undefined
   */
  keepEscaping?: boolean | undefined;
  /**
   * Do not strip quotes from the result.
   *
   * @default undefined
   */
  keepQuotes?: boolean | undefined;
}

// Ambient type override for braces to allow string or string[] as pattern
declare module "braces" {
  function braces(pattern: string | string[], options?: Options): string[];
  namespace braces {
    function expand(pattern: string | string[]): string[];
  }

  export = braces;
}
