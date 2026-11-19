/**
 * Connects the completion engine to Monaco: one provider for the `pgsql` language, asked for
 * items at the cursor, answering from `complete()`. It is registered when the SQL editor opens
 * and disposed when it closes, so no provider outlives the view. Nothing is sent anywhere.
 */
import type * as Monaco from "monaco-editor/editor/editor.api.js";
import type { MonacoApi } from "../monaco-setup";
import type { Catalog } from "./catalog";
import { complete, type CompletionItem, type ItemKind } from "./complete";

/** Wait this long for a catalog that is still loading; after that the keywords still come. */
const CATALOG_WAIT_MS = 1500;

function kindOf(monaco: MonacoApi, kind: ItemKind): Monaco.languages.CompletionItemKind {
  const k = monaco.languages.CompletionItemKind;
  switch (kind) {
    case "schema":
      return k.Module;
    case "table":
      return k.Struct;
    case "view":
      return k.Interface;
    case "column":
      return k.Field;
    case "function":
      return k.Function;
    case "alias":
      return k.Variable;
    case "snippet":
      return k.Snippet;
    default:
      return k.Keyword;
  }
}

export function registerSqlCompletion(
  monaco: MonacoApi,
  getCatalog: () => Promise<Catalog | null>,
): Monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider("pgsql", {
    triggerCharacters: ["."],
    async provideCompletionItems(model, position) {
      const catalog = await Promise.race([
        getCatalog(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), CATALOG_WAIT_MS)),
      ]);
      const result = complete(catalog, model.getValue(), model.getOffsetAt(position));
      if (result.items.length === 0) return { suggestions: [] };
      const from = model.getPositionAt(result.replaceFrom);
      const to = model.getPositionAt(result.replaceTo);
      const range = {
        startLineNumber: from.lineNumber,
        startColumn: from.column,
        endLineNumber: to.lineNumber,
        endColumn: to.column,
      };
      return {
        suggestions: result.items.map((item: CompletionItem) => ({
          label: item.label,
          kind: kindOf(monaco, item.kind),
          detail: item.detail,
          insertText: item.insertText,
          filterText: item.filterText,
          sortText: item.sortText,
          range,
          ...(item.snippet
            ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
            : {}),
          ...(item.retrigger ? { command: { id: "editor.action.triggerSuggest", title: "" } } : {}),
        })),
      };
    },
  });
}
