"use strict";

module.exports = {
  meta: {
    name: 'no-duplicated-task-keys',
    version: '0.0.1',
  },
  create(context) {
    function checkForDuplicateTaskKeys(blockStatement, reportNode) {
      const uniqueTaskKeys = new Set();
    
      blockStatement.body.forEach((expressionStatement) => {
        const literals = expressionStatement.expression.argument.arguments.filter(arg => arg.type === 'Literal');
    
        if (literals.length === 0) return;
    
        literals.forEach((taskKeyLiteral) => {
          if (uniqueTaskKeys.has(taskKeyLiteral.value)) {
            context.report({
              node: reportNode,
              message: `Task key '${taskKeyLiteral.value}' is duplicated`
            });
          }
    
          uniqueTaskKeys.add(taskKeyLiteral.value);
        });
      });
    }

    return {
      "CallExpression > MemberExpression > Identifier[name='defineJob']": (node) => {
        // Closest parent between task key and defineJob
        const RunBlockStatement = node.parent.parent.arguments[0].properties[0].value.body;

        checkForDuplicateTaskKeys(RunBlockStatement, node);
      }
    }
  }
}