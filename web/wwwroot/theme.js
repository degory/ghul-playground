// Editor themes, matched to how ghul.dev renders a static example.
//
// A reader clicking edit should see the same colours they were already looking
// at. The static examples are coloured by the compiler's semantic tokens using
// VS Code's stock Light+ and Dark+ values, so the editor uses the same ones,
// and turns semantic highlighting on so identifiers are coloured by what the
// compiler resolved them to rather than by the grammar's guess.

// Semantic token type -> colour. Monaco matches a theme rule's token name
// against the semantic token type, so these double as the semantic palette.
const LIGHT = {
    namespace: '267F99',
    class: '267F99',
    interface: '267F99',
    struct: '267F99',
    enum: '267F99',
    typeParameter: '267F99',
    enumMember: '0070C1',
    method: '795E26',
    function: '795E26',
    property: '001080',
    variable: '001080',
    parameter: '001080'
};

const DARK = {
    namespace: '4EC9B0',
    class: '4EC9B0',
    interface: 'B8D7A3',
    struct: '4EC9B0',
    enum: '4EC9B0',
    typeParameter: '4EC9B0',
    enumMember: '4FC1FF',
    method: 'DCDCAA',
    function: 'DCDCAA',
    property: '9CDCFE',
    variable: '9CDCFE',
    parameter: '9CDCFE'
};

// What the grammar colours, as against what the compiler colours. Semantic
// tokens only cover identifiers the analyser resolved; keywords, strings,
// comments and numbers come from the Monarch grammar, and without these they
// fall back to Monaco's stock theme and disagree with the rendered example
// beside them.
const LIGHT_SYNTAX = {
    keyword: '0000FF',
    // Control flow is a different colour from every other keyword, which is
    // how ghul.dev and the VS Code extension both render it.
    'keyword.control': 'AF00DB',
    'keyword.type': '0000FF',
    constant: '0000FF',
    'type.identifier': '267F99',
    identifier: '001080',
    string: 'A31515',
    'string.quote': 'A31515',
    'string.escape': 'EE0000',
    comment: '008000',
    number: '098658',
    'number.float': '098658',
    'number.hex': '098658',
    operator: '000000',
    delimiter: '000000',
    'delimiter.bracket': '000000'
};

const DARK_SYNTAX = {
    keyword: '569CD6',
    'keyword.control': 'C586C0',
    'keyword.type': '569CD6',
    constant: '569CD6',
    'type.identifier': '4EC9B0',
    identifier: '9CDCFE',
    string: 'CE9178',
    'string.quote': 'CE9178',
    'string.escape': 'D7BA7D',
    comment: '6A9955',
    number: 'B5CEA8',
    'number.float': 'B5CEA8',
    'number.hex': 'B5CEA8',
    operator: 'D4D4D4',
    delimiter: 'D4D4D4',
    'delimiter.bracket': 'D4D4D4'
};

const rules = (...palettes) =>
    palettes.flatMap(palette =>
        Object.entries(palette).map(([token, foreground]) => ({ token, foreground })));

export const LIGHT_THEME = 'ghul-light';
export const DARK_THEME = 'ghul-dark';

export function defineThemes() {
    monaco.editor.defineTheme(LIGHT_THEME, {
        base: 'vs',
        inherit: true,
        // Without this Monaco ignores the semantic token stream entirely and
        // falls back to the grammar, which is the difference being fixed.
        semanticHighlighting: true,
        rules: rules(LIGHT_SYNTAX, LIGHT),
        colors: {}
    });

    monaco.editor.defineTheme(DARK_THEME, {
        base: 'vs-dark',
        inherit: true,
        semanticHighlighting: true,
        rules: rules(DARK_SYNTAX, DARK),
        colors: {}
    });
}

// The site asks for Monaco's stock theme names; map them onto ours.
export function themeName(requested) {
    return requested === 'vs-dark' || requested === 'dark' ? DARK_THEME : LIGHT_THEME;
}
