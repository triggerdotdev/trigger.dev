import prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/plugins/line-numbers/prism-line-numbers";
import "prismjs/plugins/line-numbers/prism-line-numbers.css";
import { marked } from "marked";

export function renderMarkdown(markdown: string) {
  const html = marked(markdown, {
    highlight: function (code, lang) {
      if (prism.languages[lang]) {
        return prism.highlight(code, prism.languages[lang], lang);
      }

      return code;
    },
  });

  return html;
}
