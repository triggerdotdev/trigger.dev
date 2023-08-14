/**
 * @fileoverview Prevent duplicated task keys on trigger.dev jobs
 * @author 
 */
"use strict";

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem', // `problem`, `suggestion`, or `layout`
    docs: {
      description: "Prevent duplicated task keys on trigger.dev jobs",
      recommended: true,
      url: null, // URL to the documentation page for this rule
    },
    fixable: null, // Or `code` or `whitespace`
    schema: [], // Add a schema if the rule has options
    messages: {
      duplicatedTaskKey: "Task key '{{taskKey}}' is duplicated"
    }
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
              messageId: 'duplicatedTaskKey',
              data: {
                taskKey: taskKeyLiteral.value
              },
            });
          }
    
          uniqueTaskKeys.add(taskKeyLiteral.value);
        });
      });
    }

    return {
      // visitor functions for different types of nodes
      "CallExpression > MemberExpression > Identifier[name='defineJob']": (node) => {
        // Closest parent between task key and defineJob
        const RunBlockStatement = node.parent.parent.arguments[0].properties[0].value.body;

        checkForDuplicateTaskKeys(RunBlockStatement, node);
      }
    }
  }
};
