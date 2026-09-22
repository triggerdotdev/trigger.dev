/** @type {import("eslint").Rule.RuleModule} */
const requireVersionedImport = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require an explicit Zod version import in packages that support multiple Zod major versions.",
    },
    fixable: "code",
    messages: {
      unversioned:
        'Import Zod 4 from "zod/v4" rather than "zod". The package supports Zod 3 and 4, so the bare import can resolve to the wrong major version.',
    },
    schema: [],
  },
  create(context) {
    function checkSource(node) {
      if (node.source?.value !== "zod") return;

      context.report({
        node: node.source,
        messageId: "unversioned",
        fix: (fixer) => fixer.replaceText(node.source, '"zod/v4"'),
      });
    }

    return {
      ImportDeclaration: checkSource,
      ExportAllDeclaration: checkSource,
      ExportNamedDeclaration: checkSource,
    };
  },
};

/** @type {import("eslint").ESLint.Plugin} */
const plugin = {
  meta: { name: "trigger-zod" },
  rules: {
    "require-versioned-import": requireVersionedImport,
  },
};

export default plugin;
