module.exports = {
  extends: ["turbo", "prettier"],
  settings: {
    react: {
      version: "detect",
    },
  },
  rules: {
    'no-duplicated-task-keys': require('./rules/no-duplicated-task-keys'),
  }
};
