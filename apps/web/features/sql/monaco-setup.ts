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
    await import("monaco-editor/editor/browser/coreCommands.js");
    await import("monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js");
    await import("monaco-editor/editor/common/standaloneStrings.js");
    await import("monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js");
    await import("monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js");
    await import("monaco-editor/editor/contrib/caretOperations/browser/transpose.js");
    await import("monaco-editor/editor/contrib/clipboard/browser/clipboard.js");
    await import("monaco-editor/editor/contrib/comment/browser/comment.js");
    await import("monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js");
    await import("monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js");
    await import("monaco-editor/features/find/register.js");
    await import("monaco-editor/editor/contrib/find/browser/findController.js");
    await import("monaco-editor/editor/contrib/folding/browser/folding.js");
    await import("monaco-editor/editor/contrib/hover/browser/hoverContribution.js");
    await import("monaco-editor/editor/contrib/indentation/browser/indentation.js");
    await import("monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js");
    await import("monaco-editor/editor/contrib/multicursor/browser/multicursor.js");
    await import("monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js");
    await import("monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js");
    await import("monaco-editor/editor/contrib/snippet/browser/snippetController2.js");
    await import("monaco-editor/editor/contrib/suggest/browser/suggestController.js");
    await import("monaco-editor/editor/contrib/tokenization/browser/tokenization.js");
    await import("monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js");
    await import("monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js");
    await import("monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js");
    await import("monaco-editor/languages/definitions/pgsql/register.js");
    return monaco;
  })();
  // A failed load can be tried again by opening the view again.
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}
