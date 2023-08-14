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
    const groupByTask = ExpressionStatements => ExpressionStatements.reduce((acc, { expression }) => {
      const property = expression.argument.callee.property;

      // We need property to be an Identifier, otherwise it's not a task
      if (property.type !== 'Identifier') return;

      // for io.slack.postMessage, taskName = postMessage
      const taskName = property.name;

      const taskKey = expression.argument.arguments.find((arg) => arg.type === 'Literal').value;

      if (acc.has(taskName)) {
        acc.get(taskName).push(taskKey);
      } else {
        acc.set(taskName, [taskKey]);
      }

      return acc;
    }, new Map());
    
    return {
      "CallExpression[callee.property.name='defineJob'] ObjectExpression BlockStatement": (node) => {
        const ExpressionStatements = node.body.filter((arg) => arg.type === 'ExpressionStatement');

        // it'll be a map of taskName => [key1, key2, ...]
        const groupedByTask = groupByTask(ExpressionStatements);

        groupedByTask.forEach((keys) => {
          // get duplicated value from keys
          const duplicated = keys.find((key, index) => keys.indexOf(key) !== index);

          if (duplicated) {
            context.report({
              node,
              messageId: 'duplicatedTaskKey',
              data: {
                taskKey: duplicated
              },
            });
          }
        })
      }
    }
  }
};
