// TypeScript translation of posthog/hogql/parse_string.py
// Keep this file in sync with the Python version

import { SyntaxError } from './errors';

function replaceCommonEscapeCharacters(text: string): string {
    // copied from clickhouse_driver/util/escape.py
    // Note: \a (bell) and \v (vertical tab) are not directly supported in JavaScript strings
    // but we handle them as escape sequences that get replaced
    text = text.replace(/\\b/g, '\b');
    text = text.replace(/\\f/g, '\f');
    text = text.replace(/\\r/g, '\r');
    text = text.replace(/\\n/g, '\n');
    text = text.replace(/\\t/g, '\t');
    text = text.replace(/\\0/g, ''); // NUL characters are ignored
    text = text.replace(/\\a/g, '\x07'); // Bell character (ASCII 7)
    text = text.replace(/\\v/g, '\x0B'); // Vertical tab (ASCII 11)
    text = text.replace(/\\\\/g, '\\');
    return text;
}

export function parseStringLiteralText(text: string): string {
    /** Converts a string received from antlr via ctx.getText() into a JavaScript string */
    let result: string;
    
    if (text.startsWith("'") && text.endsWith("'")) {
        result = text.slice(1, -1);
        result = result.replace(/''/g, "'");
        result = result.replace(/\\'/g, "'");
    } else if (text.startsWith('"') && text.endsWith('"')) {
        result = text.slice(1, -1);
        result = result.replace(/""/g, '"');
        result = result.replace(/\\"/g, '"');
    } else if (text.startsWith('`') && text.endsWith('`')) {
        result = text.slice(1, -1);
        result = result.replace(/``/g, '`');
        result = result.replace(/\\`/g, '`');
    } else if (text.startsWith('{') && text.endsWith('}')) {
        result = text.slice(1, -1);
        result = result.replace(/{{/g, '{');
        result = result.replace(/\\{/g, '{');
    } else {
        throw new SyntaxError(`Invalid string literal, must start and end with the same quote type: ${text}`);
    }

    return replaceCommonEscapeCharacters(result);
}

export function parseStringLiteralCtx(ctx: { getText(): string }): string {
    /** Converts a STRING_LITERAL received from antlr via ctx.getText() into a JavaScript string */
    const text = ctx.getText();
    return parseStringLiteralText(text);
}

export function parseStringTextCtx(ctx: { getText(): string }, escapeQuotes: boolean = true): string {
    /** Converts a STRING_TEXT received from antlr via ctx.getText() into a JavaScript string */
    let text = ctx.getText();
    if (escapeQuotes) {
        text = text.replace(/''/g, "'");
        text = text.replace(/\\'/g, "'");
    }
    text = text.replace(/\\{/g, '{');
    return replaceCommonEscapeCharacters(text);
}

