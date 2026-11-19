/**
 * Monaco, loaded once and only when the SQL view opens (decision 142).
 *
 * It is imported from `editor.api` plus a FIXED list of features and the `pgsql` language,
 * never from `monaco-editor` itself (which brings every language and the TypeScript, CSS,
 * JSON and HTML services: 18 MB more). The list is the one tested in milestone S0: a shorter
 * one breaks the completion list and select all. Nothing is fetched from another host; the
 * worker is built into the package.
 */
import type * as Monaco from "monaco-editor/editor/editor.api.js";

export type MonacoApi = typeof Monaco;

let loading: Promise<MonacoApi> | undefined;

export function loadMonaco(): Promise<MonacoApi> {
  loading ??= (async () => {
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker: () =>
        new Worker(new URL("monaco-editor/editor/editor.worker.js", import.meta.url), {
          type: "module",
        }),
    };
    const monaco = await import("monaco-editor/editor/editor.api.js");
    // The features register themselves with the editor; they can be fetched together.
    await Promise.all([
      import("monaco-editor/editor/browser/coreCommands.js"),
      import("monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js"),
      import("monaco-editor/editor/common/standaloneStrings.js"),
      import("monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js"),
      import("monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js"),
      import("monaco-editor/editor/contrib/caretOperations/browser/transpose.js"),
      import("monaco-editor/editor/contrib/clipboard/browser/clipboard.js"),
      import("monaco-editor/editor/contrib/comment/browser/comment.js"),
      import("monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js"),
      import("monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js"),
      import("monaco-editor/features/find/register.js"),
      import("monaco-editor/editor/contrib/find/browser/findController.js"),
      import("monaco-editor/editor/contrib/folding/browser/folding.js"),
      import("monaco-editor/editor/contrib/hover/browser/hoverContribution.js"),
      import("monaco-editor/editor/contrib/indentation/browser/indentation.js"),
      import("monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js"),
      import("monaco-editor/editor/contrib/multicursor/browser/multicursor.js"),
      import("monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js"),
      import("monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js"),
      import("monaco-editor/editor/contrib/snippet/browser/snippetController2.js"),
      import("monaco-editor/editor/contrib/suggest/browser/suggestController.js"),
      import("monaco-editor/editor/contrib/tokenization/browser/tokenization.js"),
      import("monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js"),
      import("monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js"),
      import("monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js"),
      import("monaco-editor/languages/definitions/pgsql/register.js"),
    ]);
    return monaco;
  })();
  // A failed load can be tried again by opening the view again.
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}
