/**
 * The colours of the JSON editor: a small Monarch tokenizer of our own, registered in the lazy Monaco.
 *
 * Monaco's own JSON support is a language service with a web worker and hundreds of KB of code
 * (decision 154); a tokenizer is a few regular expressions, adds nothing to the bundle and needs no
 * worker. The CHECKING (what is wrong, and where) is `checkJson`, shown by the editor as markers.
 * A key is told from a string value by what follows it (a colon), which a single line can see
 * because a JSON string cannot hold a line break.
 */
import type { MonacoApi } from "@/features/sql/monaco-setup";

export const JSON_LANGUAGE_ID = "datacanvas-json";

/** The rules in the order they are tried. Exported so a test can run them without Monaco. */
export const JSON_TOKEN_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/[ \t\r\n]+/, "white"],
  [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "string.key.json"],
  [/"(?:[^"\\]|\\.)*"/, "string.value.json"],
  // A string that is not closed on its line: marked, so it does not colour what follows as a string.
  [/"(?:[^"\\]|\\.)*$/, "string.invalid"],
  [/-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/, "number.json"],
  [/\b(?:true|false|null)\b/, "keyword.json"],
  [/[{}[\]]/, "@brackets"],
  [/[,:]/, "delimiter"],
];

let registered = false;

/** Register the language once per page. Safe to call again. */
export function registerJsonLanguage(monaco: MonacoApi): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: JSON_LANGUAGE_ID });
  monaco.languages.setMonarchTokensProvider(JSON_LANGUAGE_ID, {
    defaultToken: "invalid",
    tokenPostfix: "",
    brackets: [
      { open: "{", close: "}", token: "delimiter.bracket" },
      { open: "[", close: "]", token: "delimiter.square" },
    ],
    tokenizer: { root: JSON_TOKEN_RULES.map(([regex, token]) => [regex, token]) },
  });
  monaco.languages.setLanguageConfiguration(JSON_LANGUAGE_ID, {
    brackets: [
      ["{", "}"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: '"', close: '"', notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
  });
}
