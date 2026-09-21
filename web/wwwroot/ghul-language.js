// Monarch grammar for ghūl. Approximate by design: it exists to give instant
// colouring while typing. Anything that needs to be correct rather than fast
// comes from the compiler, via diagnostics today and semantic tokens later.

export const GHUL_LANGUAGE = {
    defaultToken: '',

    // Compiles every rule below with the regular-expression unicode flag,
    // which the property escapes they use need.
    unicode: true,

    // Split exactly as the VS Code extension's TextMate grammar splits it, so
    // the same word is the same colour whether it is being read on ghul.dev,
    // edited here, or opened in an editor: control flow is one colour and
    // everything else another. Colouring every keyword alike is the difference
    // a reader notices first.
    controlKeywords: [
        'assert', 'if', 'then', 'elif', 'else', 'fi',
        'for', 'in', 'while', 'do', 'od', 'continue', 'break',
        'case', 'when', 'default', 'esac',
        'throw', 'try', 'catch', 'finally', 'yrt',
        'return', 'yield', 'await'
    ],

    keywords: [
        'namespace', 'use', 'class', 'struct', 'trait', 'union', 'enum',
        'partial', 'impl', 'is', 'si',
        'val', 'lav', 'let', 'mut',
        'cast', 'isa', 'typeof', 'super', 'self', 'rec',
        'static', 'public', 'private', 'protected', 'field', 'init',
        'abstract', 'open', 'pure', 'impure', 'optional', 'innate',
        'new', 'entry', 'deconstruct'
    ],

    types: [
        'int', 'bool', 'char', 'string', 'object', 'void',
        'byte', 'ubyte', 'short', 'ushort', 'uint', 'long', 'ulong',
        'word', 'uword', 'single', 'double', 'decimal'
    ],

    constants: ['true', 'false', 'null'],

    // A run of operator characters scans as one token in ghūl, so match
    // greedily rather than character by character. The characters are the
    // ASCII set and any non-ASCII character Unicode classes as a symbol, so
    // × and ∪ are operators; the backtick is the identifier escape
    // rather than an operator, and is left out.
    symbols: /(?:[=><!~?:&|+\-*\/^%\\.]|(?=[^\x00-\x7F])\p{S})+/u,

    // A letter of any script starts an identifier, and a letter, a digit, a
    // combining mark or a connecting punctuation mark continues one. A letter
    // is never a symbol, so an identifier and an operator never overlap.
    identifierStart: /[\p{L}\p{Nl}_$]/u,
    identifierPart: /[\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}$]/u,

    // A backtick escapes what follows it, so a name that would read as a
    // keyword, as a numeric literal or as an operator is read as a name.
    escapedName: /`(?:@identifierPart+|@symbols)/,

    tokenizer: {
        root: [
            [/@escapedName/, 'identifier'],

            // A name in upper case throughout is a type by convention. The
            // trailing look-ahead is what `\b` was doing, spelled so that it
            // holds for a letter outside the ASCII word characters too.
            [/\p{Lu}[\p{Lu}\p{Nd}_]*(?!@identifierPart)/u, 'type.identifier'],

            [/@identifierStart@identifierPart*/, {
                cases: {
                    '@controlKeywords': 'keyword.control',
                    '@keywords': 'keyword',
                    '@types': 'keyword.type',
                    '@constants': 'constant',
                    '@default': 'identifier'
                }
            }],

            { include: '@whitespace' },

            [/[()\[\]]/, '@brackets'],

            [/@symbols/, 'operator'],

            [/\d[\d_]*\.[\d_]+([eE][\-+]?\d+)?[sdmSDM]?/, 'number.float'],
            [/0[xX][0-9a-fA-F_]+[a-zA-Z]*/, 'number.hex'],
            [/\d[\d_]*[a-zA-Z]*/, 'number'],

            [/[;,]/, 'delimiter'],

            [/"/, { token: 'string.quote', bracket: '@open', next: '@string' }],
            [/'[^\\']'/, 'string'],
            [/'\\.'/, 'string.escape']
        ],

        whitespace: [
            [/[ \t\r\n]+/, ''],
            [/\/\/.*$/, 'comment']
        ],

        string: [
            // Interpolation: the braces open expression context, so colour the
            // delimiters and hand the contents back to the root rules.
            [/\{\{/, 'string'],
            [/\}\}/, 'string'],
            [/\{/, { token: 'delimiter.bracket', next: '@interpolation' }],
            [/[^\\"{]+/, 'string'],
            [/\\./, 'string.escape'],
            [/"/, { token: 'string.quote', bracket: '@close', next: '@pop' }]
        ],

        interpolation: [
            [/\}/, { token: 'delimiter.bracket', next: '@pop' }],
            { include: '@root' }
        ]
    }
};

export const GHUL_CONFIGURATION = {
    comments: { lineComment: '//' },
    brackets: [['(', ')'], ['[', ']']],
    autoClosingPairs: [
        { open: '(', close: ')' },
        { open: '[', close: ']' },
        { open: '"', close: '"' }
    ],
    // Named collapsible regions, opened by `// a name >>>` and closed by
    // `// <<<`. The name is free text and the closing marker need not repeat
    // it; regions nest, and an unmatched marker is ignored rather than
    // reported.
    foldingRules: {
        markers: {
            start: /^\s*\/\/.*>>>\s*$/,
            end: /^\s*\/\/.*<<<\s*$/
        }
    },
    // The keyword pairs are ghūl's block delimiters, so indent between them.
    indentationRules: {
        increaseIndentPattern: /\b(is|then|do|try|val)\s*$/,
        decreaseIndentPattern: /^\s*(si|fi|od|yrt|lav|elif|else|catch|finally)\b/
    }
};
