// Monarch grammar for ghūl. Approximate by design: it exists to give instant
// colouring while typing. Anything that needs to be correct rather than fast
// comes from the compiler, via diagnostics today and semantic tokens later.

export const GHUL_LANGUAGE = {
    defaultToken: '',

    keywords: [
        'namespace', 'use', 'class', 'struct', 'trait', 'union', 'enum',
        'partial', 'impl', 'for', 'is', 'si',
        'if', 'then', 'elif', 'else', 'fi',
        'while', 'do', 'od', 'in',
        'case', 'when', 'esac',
        'try', 'catch', 'finally', 'yrt',
        'val', 'lav', 'let', 'mut',
        'return', 'break', 'continue', 'throw', 'assert',
        'cast', 'isa', 'super', 'self', 'rec',
        'static', 'public', 'private', 'protected', 'field', 'init',
        'abstract', 'open', 'pure', 'impure', 'default',
        'await', 'yield', 'new', 'entry', 'deconstruct'
    ],

    types: [
        'int', 'bool', 'char', 'string', 'object', 'void',
        'byte', 'ubyte', 'short', 'ushort', 'uint', 'long', 'ulong',
        'word', 'uword', 'single', 'double', 'decimal'
    ],

    constants: ['true', 'false', 'null'],

    // A run of operator characters scans as one token in ghūl, so match
    // greedily rather than character by character.
    symbols: /[=><!~?:&|+\-*\/^%\\.]+/,

    tokenizer: {
        root: [
            [/[A-Z][A-Z0-9_]*\b/, 'type.identifier'],

            [/[a-zA-Z_$][\w$]*/, {
                cases: {
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
    // The keyword pairs are ghūl's block delimiters, so indent between them.
    indentationRules: {
        increaseIndentPattern: /\b(is|then|do|try|val)\s*$/,
        decreaseIndentPattern: /^\s*(si|fi|od|yrt|lav|elif|else|catch|finally)\b/
    }
};
