lexer grammar TRQLLexer;

@header {
// put any global imports you need here
}

@members {

private _peekChar(k: number): string {
    // Return the k-th look-ahead as a *single-char string* or '\0' at EOF.
    const c = this._input.LA(k);          // int code point or IntStream.EOF (-1)
    if (c < 0 || c > 0x10FFFF) {         // EOF or out-of-range → sentinel
        return '\0';
    }
    return String.fromCharCode(c);
}

private _skipWsAndComments(idx: number): number {
    // Return the first index ≥ idx that is *not* whitespace / single-line comment.
    while (true) {
        const ch = this._peekChar(idx);
        if (/\s/.test(ch)) {                  // spaces, newlines, tabs …
            idx++;
            continue;
        }

        // single-line comments
        if (ch === '/' && this._peekChar(idx + 1) === '/') {     // //
            idx += 2;
        } else if (ch === '-' && this._peekChar(idx + 1) === '-') {   // --
            idx += 2;
        } else if (ch === '#') {                                       // #
            idx++;
        } else {
            break;                                             // no ws / comment
        }
        // consume until EOL / EOF
        while (!['\0', '\n', '\r'].includes(this._peekChar(idx))) {
            idx++;
        }
    }
    return idx;
}

// ───── opening tag test ─────
isOpeningTag(): boolean {
    const ch1 = this._peekChar(1);
    if (!(/[a-zA-Z]/.test(ch1) || ch1 === '_')) {
        return false;                           // not a tag name start
    }

    // skip tag name
    let i = 2;
    while (true) {
        const ch = this._peekChar(i);
        if (/[a-zA-Z0-9]/.test(ch) || ch === '_' || ch === '-') {
            i++;
        } else {
            break;
        }
    }

    let ch = this._peekChar(i);

    // immediate delimiter → tag
    if (ch === '>' || ch === '/') {
        return true;
    }

    // need to look beyond whitespace
    if (/\s/.test(ch)) {
        i = this._skipWsAndComments(i + 1);
        ch = this._peekChar(i);
        return ch === '>' || ch === '/' || /[a-zA-Z0-9]/.test(ch) || ch === '_';
    }

    // anything else → not a tag
    return false;
}

}