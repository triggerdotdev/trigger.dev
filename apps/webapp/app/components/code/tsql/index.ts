// TSQL CodeMirror support
// Provides syntax highlighting, autocompletion, and linting for TSQL queries

export { createTSQLCompletion } from "./tsqlCompletion";
export { createTSQLLinter, isValidTSQLQuery, getTSQLError, type TSQLLinterConfig } from "./tsqlLinter";

