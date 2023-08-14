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
    const getTaskNameAndKey = (expression) => {
      const property = expression.argument.callee.property;

      // We need property to be an Identifier, otherwise it's not a task
      if (property.type !== 'Identifier') return;

      // for io.slack.postMessage, taskName = postMessage
      const taskName = property.name;

      const taskKey = expression.argument.arguments.find((arg) => arg.type === 'Literal').value;

      return [taskName, taskKey]
    }

    const groupExpressionsByTask = (ExpressionStatements, map = new Map()) => ExpressionStatements.reduce((acc, { expression }) => {
      const [taskName, taskKey] = getTaskNameAndKey(expression);

      if (acc.has(taskName)) {
        acc.get(taskName).push(taskKey);
      } else {
        acc.set(taskName, [taskKey]);
      }

      return acc;
    }, map);

    const groupVariableDeclarationsByTask = VariableDeclarations => VariableDeclarations.reduce((acc, { declarations }) => {
      declarations.forEach((declaration) => {
        // We need declaration.init to be a CallExpression or AwaitExpression, otherwise it's not a task
        if (!['CallExpression', 'AwaitExpression'].includes(declaration.init.type)) return;

        const [taskName, taskKey] = getTaskNameAndKey(declaration.init);

        if (acc.has(taskName)) {
          acc.get(taskName).push(taskKey);
        } else {
          acc.set(taskName, [taskKey]);
        }
      });

      return acc;
    }, new Map());
    
    return {
      "CallExpression[callee.property.name='defineJob'] ObjectExpression BlockStatement": (node) => {
        const VariableDeclarations = node.body.filter((arg) => arg.type === 'VariableDeclaration');

        const grouped = groupVariableDeclarationsByTask(VariableDeclarations);

        const ExpressionStatements = node.body.filter((arg) => arg.type === 'ExpressionStatement');

        // it'll be a map of taskName => [key1, key2, ...]
        const groupedByTask = groupExpressionsByTask(ExpressionStatements, grouped);

        groupedByTask.forEach((keys) => {
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
