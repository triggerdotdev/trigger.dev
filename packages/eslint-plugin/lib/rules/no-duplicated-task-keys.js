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
    const getArguments = (node) => node.arguments || node.argument.arguments;

    const getKey = (node) => {
      const args = getArguments(node);

      const key = args.find((arg) => arg.type === 'Literal');

      if (!key) return;

      return key.value;
    }

    const getTaskName = (expression) => {
      const callee = expression.callee || expression.argument.callee;

      const property = callee.property;

      // We need property to be an Identifier, otherwise it's not a task
      if (property.type !== 'Identifier') return;

      // for io.slack.postMessage, postMessage
      return property.name;
    }

    const groupExpressionsByTask = (ExpressionStatements, map = new Map()) => ExpressionStatements.reduce((acc, { expression }) => {
      const taskName = getTaskName(expression);
      const taskKey = getKey(expression);

      if (acc.has(taskName)) {
        acc.get(taskName).push(taskKey);
      } else {
        acc.set(taskName, [taskKey]);
      }

      return acc;
    }, map);

    const groupVariableDeclarationsByTask = VariableDeclarations => VariableDeclarations.reduce((acc, { declarations }) => {
      declarations.forEach((declaration) => {
        if (!['AwaitExpression', 'CallExpression'].includes(declaration.init.type)) return;

        const taskName = getTaskName(declaration.init);
        
        const taskKey = getKey(declaration.init);

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
