/**
 * The Monaco editor of the JSON dialog. Loaded on demand (`next/dynamic`, no server rendering) and
 * from the same lazy Monaco as the SQL view (decision 142): nothing is fetched until a JSON editor
 * is opened. The colours are our own tokenizer (`json-language.ts`); where the document stops being
 * JSON is a marker at the place `checkJson` found, with its message.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor/editor/editor.api.js";
import { LoadingState } from "@/components/states/loading-state";
import { loadMonaco, type MonacoApi } from "@/features/sql/monaco-setup";
import { applyAppTheme } from "@/features/sql/monaco-theme";
import { useThemeStore } from "@/stores/theme-store";
import { JSON_LANGUAGE_ID, registerJsonLanguage } from "./json-language";
import type { JsonError } from "./json-text";

export interface JsonCodeEditorProps {
  value: string;
  onChange: (text: string) => void;
  readOnly: boolean;
  /** Where the text stops being JSON, or null. */
  error: JsonError | null;
  ariaLabel: string;
}

const MARKER_OWNER = "datacanvas-json";

export default function JsonCodeEditor({
  value,
  onChange,
  readOnly,
  error,
  ariaLabel,
}: JsonCodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [monaco, setMonaco] = useState<MonacoApi | null>(null);
  const [failed, setFailed] = useState(false);
  const resolved = useThemeStore((s) => s.resolved);

  // The editor is made once and keeps asking for the latest callback and starting text.
  const latest = useRef({ onChange, value });
  useEffect(() => {
    latest.current = { onChange, value };
  });

  useEffect(() => {
    let disposed = false;
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null;
    loadMonaco().then(
      (api) => {
        if (disposed || !host.current) return;
        registerJsonLanguage(api);
        const model = api.editor.createModel(latest.current.value, JSON_LANGUAGE_ID);
        model.setEOL(api.editor.EndOfLineSequence.LF);
        editor = api.editor.create(host.current, {
          model,
          ariaLabel,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 13,
          lineNumbersMinChars: 3,
          renderLineHighlight: "line",
          fixedOverflowWidgets: true,
          tabSize: 2,
          insertSpaces: true,
          wordWrap: "on",
          padding: { top: 8, bottom: 8 },
          bracketPairColorization: { enabled: true },
          matchBrackets: "always",
          wordBasedSuggestions: "off",
          quickSuggestions: false,
          suggestOnTriggerCharacters: false,
          readOnly,
        });
        applyAppTheme(api, useThemeStore.getState().resolved === "dark");
        editor.onDidChangeModelContent(() => {
          // An edit clears the mark: it pointed into the text as it was.
          api.editor.setModelMarkers(model, MARKER_OWNER, []);
          latest.current.onChange(model.getValue());
        });
        editorRef.current = editor;
        setMonaco(api);
      },
      () => setFailed(true),
    );
    return () => {
      disposed = true;
      editorRef.current = null;
      const model = editor?.getModel();
      editor?.dispose();
      model?.dispose();
    };
    // The editor is made once; its text, theme and flags are kept up to date below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Text that changed from outside (Format, Minify, a reset): put it in as an edit, so undo still works.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!monaco || !editor || !model || model.getValue() === value) return;
    editor.executeEdits("datacanvas", [{ range: model.getFullModelRange(), text: value }]);
    editor.pushUndoStop();
  }, [monaco, value]);

  useEffect(() => {
    if (monaco) applyAppTheme(monaco, resolved === "dark");
  }, [monaco, resolved]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly, monaco]);

  // Mark the place the checker named.
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    if (!error) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
      return;
    }
    const start = model.getPositionAt(Math.min(error.offset, model.getValueLength()));
    const word = model.getWordAtPosition(start);
    const endColumn = word && word.startColumn <= start.column ? word.endColumn : start.column + 1;
    monaco.editor.setModelMarkers(model, MARKER_OWNER, [
      {
        severity: monaco.MarkerSeverity.Error,
        message: error.message,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: start.lineNumber,
        endColumn,
      },
    ]);
  }, [monaco, error]);

  if (failed) {
    return (
      <div role="alert" className="p-4 text-sm text-destructive">
        The editor could not be loaded. Close this window and open it again.
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
