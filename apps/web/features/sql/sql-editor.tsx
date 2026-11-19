/**
 * The Monaco editor of the SQL view. Loaded on demand (`next/dynamic`, no server rendering),
 * so Monaco is in neither the first page nor the server bundle (decision 142).
 *
 * It holds the text itself and reports changes; the store keeps the text between visits to
 * the tab. Ctrl or Cmd plus Enter runs the selection if there is one, else everything.
 * A refused statement is marked in the text at the place the database named, and the mark
 * goes away when the text is edited. Tab moves focus on with Escape first (Monaco's own
 * rule for keyboard users: Escape, then Tab), which the view says in its hint.
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
  /** The text the editor starts with (later changes come from the person typing). */
  initialValue: string;
  onChange: (text: string) => void;
  /** Run what is selected, or everything: the text and where it starts (characters from the top). */
  onRun: (text: string, base: number) => void;
  marker: EditorMarker | null;
  readOnly?: boolean;
}

export default function SqlEditor({
  initialValue,
  onChange,
  onRun,
  marker,
  readOnly = false,
}: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [monaco, setMonaco] = useState<MonacoApi | null>(null);
  const [failed, setFailed] = useState(false);
  const resolved = useThemeStore((s) => s.resolved);

  // The callbacks change on every render; the editor keeps asking the latest ones.
  const latest = useRef({ onChange, onRun });
  useEffect(() => {
    latest.current = { onChange, onRun };
  });

  useEffect(() => {
    let disposed = false;
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
    loadMonaco().then(
      (api) => {
        if (disposed || !host.current) return;
        editor = api.editor.create(host.current, {
          value: initialValue,
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
          readOnly,
        });
        editor.getModel()?.setEOL(api.editor.EndOfLineSequence.LF);
        editor.onDidChangeModelContent(() => {
          // An edit clears the mark: it pointed into the text as it was.
          const model = editor?.getModel();
          if (model) api.editor.setModelMarkers(model, "datacanvas-sql", []);
          latest.current.onChange(editor?.getValue() ?? "");
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
                model.getValueInRange(selection),
                model.getOffsetAt(selection.getStartPosition()),
              );
            } else {
              latest.current.onRun(model.getValue(), 0);
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
    };
    // The editor is made once; its text and theme are updated below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    monaco?.editor.setTheme(resolved === "dark" ? "vs-dark" : "vs");
  }, [monaco, resolved]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly, monaco]);

  // Mark the place the database named.
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    if (!marker) {
      monaco.editor.setModelMarkers(model, "datacanvas-sql", []);
      return;
    }
    const start = model.getPositionAt(Math.max(0, marker.offset - 1));
    // From there to the end of the word (or one character), so the squiggle is visible.
    const word = model.getWordAtPosition(start);
    const endColumn = word && word.startColumn <= start.column ? word.endColumn : start.column + 1;
    monaco.editor.setModelMarkers(model, "datacanvas-sql", [
      {
        severity: monaco.MarkerSeverity.Error,
        message: marker.message,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: start.lineNumber,
        endColumn,
      },
    ]);
  }, [monaco, marker]);

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
