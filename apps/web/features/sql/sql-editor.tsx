/**
 * The Monaco editor of the SQL view. Loaded on demand (`next/dynamic`, no server rendering),
 * so Monaco is in neither the first page nor the server bundle (decision 142).
 *
 * One editor, one text MODEL per query tab: switching tabs swaps the model, so each tab keeps
 * its own undo history, cursor and scroll position. The store keeps the text between visits to
 * the SQL tab; a model is made from it the first time a tab is shown and dropped when the tab
 * is closed. Ctrl or Cmd plus Enter runs the selection if there is one, else everything. A
 * refused statement is marked in the text at the place the database named, and the mark goes
 * away when the text is edited. Tab moves focus on with Escape first (Monaco's own rule for
 * keyboard users: Escape, then Tab), which the view says in its hint.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor/editor/editor.api.js";
import { LoadingState } from "@/components/states/loading-state";
import { useThemeStore } from "@/stores/theme-store";
import { loadMonaco, type MonacoApi } from "./monaco-setup";

export interface EditorMarker {
  /** 1-based character position in the whole text. */
  offset: number;
  message: string;
}

export interface SqlEditorProps {
  /** The tab shown. */
  tabId: string;
  /** The text a tab's model starts with, the first time the tab is shown. */
  textFor: (tabId: string) => string;
  /** The tabs that exist: the models of other tabs are dropped. */
  openTabIds: string[];
  onChange: (tabId: string, text: string) => void;
  /** Run what is selected, or everything: the text and where it starts (characters from the top). */
  onRun: (tabId: string, text: string, base: number) => void;
  marker: EditorMarker | null;
  readOnly?: boolean;
}

const MARKER_OWNER = "datacanvas-sql";

export default function SqlEditor({
  tabId,
  textFor,
  openTabIds,
  onChange,
  onRun,
  marker,
  readOnly = false,
}: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const models = useRef(new Map<string, Monaco.editor.ITextModel>());
  const viewStates = useRef(new Map<string, Monaco.editor.ICodeEditorViewState | null>());
  const shownTab = useRef<string | null>(null);
  const [monaco, setMonaco] = useState<MonacoApi | null>(null);
  const [failed, setFailed] = useState(false);
  const resolved = useThemeStore((s) => s.resolved);

  // The callbacks change on every render; the editor keeps asking the latest ones.
  const latest = useRef({ tabId, onChange, onRun });
  useEffect(() => {
    latest.current = { tabId, onChange, onRun };
  });

  useEffect(() => {
    let disposed = false;
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
    const modelsOfThisEditor = models.current;
    loadMonaco().then(
      (api) => {
        if (disposed || !host.current) return;
        editor = api.editor.create(host.current, {
          model: null,
          language: "pgsql",
          theme: useThemeStore.getState().resolved === "dark" ? "vs-dark" : "vs",
          ariaLabel: "SQL editor",
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 13,
          lineNumbersMinChars: 3,
          renderLineHighlight: "line",
          fixedOverflowWidgets: true,
          tabSize: 2,
          wordWrap: "on",
          padding: { top: 8, bottom: 8 },
        });
        editor.onDidChangeModelContent(() => {
          // An edit clears the mark: it pointed into the text as it was.
          const model = editor?.getModel();
          if (model) api.editor.setModelMarkers(model, MARKER_OWNER, []);
          latest.current.onChange(latest.current.tabId, model?.getValue() ?? "");
        });
        editor.addAction({
          id: "datacanvas.run",
          label: "Run statement",
          keybindings: [api.KeyMod.CtrlCmd | api.KeyCode.Enter],
          run: (ed) => {
            const model = ed.getModel();
            if (!model) return;
            const selection = ed.getSelection();
            if (selection && !selection.isEmpty()) {
              latest.current.onRun(
                latest.current.tabId,
                model.getValueInRange(selection),
                model.getOffsetAt(selection.getStartPosition()),
              );
            } else {
              latest.current.onRun(latest.current.tabId, model.getValue(), 0);
            }
          },
        });
        editorRef.current = editor;
        setMonaco(api);
      },
      () => setFailed(true),
    );
    return () => {
      disposed = true;
      editorRef.current = null;
      editor?.dispose();
      for (const model of modelsOfThisEditor.values()) model.dispose();
      modelsOfThisEditor.clear();
    };
  }, []);

  // Show the model of the tab: make it the first time, and put back the cursor and scroll.
  useEffect(() => {
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const previous = shownTab.current;
    if (previous === tabId) return;
    if (previous !== null) viewStates.current.set(previous, editor.saveViewState());
    let model = models.current.get(tabId);
    if (!model) {
      model = monaco.editor.createModel(textFor(tabId), "pgsql");
      model.setEOL(monaco.editor.EndOfLineSequence.LF);
      models.current.set(tabId, model);
    }
    editor.setModel(model);
    const state = viewStates.current.get(tabId);
    if (state) editor.restoreViewState(state);
    // Switching tabs puts you back to typing; the first tab does not take focus from the page.
    if (previous !== null) editor.focus();
    shownTab.current = tabId;
  }, [monaco, tabId, textFor]);

  // Drop the models of tabs that were closed.
  useEffect(() => {
    for (const [id, model] of models.current) {
      if (!openTabIds.includes(id) && id !== shownTab.current) {
        model.dispose();
        models.current.delete(id);
        viewStates.current.delete(id);
      }
    }
  }, [openTabIds]);

  useEffect(() => {
    monaco?.editor.setTheme(resolved === "dark" ? "vs-dark" : "vs");
  }, [monaco, resolved]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly, monaco]);

  // Mark the place the database named, in the model that is shown.
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    if (!marker) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
      return;
    }
    const start = model.getPositionAt(Math.max(0, marker.offset - 1));
    // From there to the end of the word (or one character), so the squiggle is visible.
    const word = model.getWordAtPosition(start);
    const endColumn = word && word.startColumn <= start.column ? word.endColumn : start.column + 1;
    monaco.editor.setModelMarkers(model, MARKER_OWNER, [
      {
        severity: monaco.MarkerSeverity.Error,
        message: marker.message,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: start.lineNumber,
        endColumn,
      },
    ]);
  }, [monaco, marker, tabId]);

  if (failed) {
    return (
      <div role="alert" className="p-4 text-sm text-destructive">
        The editor could not be loaded. Close this view and open it again.
      </div>
    );
  }
  return (
    <div className="relative h-full min-h-0 w-full">
      {monaco ? null : (
        <div className="absolute inset-0 flex items-center justify-center">
          <LoadingState label="Loading the editor…" />
        </div>
      )}
      <div ref={host} className="h-full w-full" />
    </div>
  );
}
