/**
 * Tells canvas components which connection they belong to, so a table node can
 * look up its metadata without the connection id being copied into every node.
 */
"use client";

import { createContext, useContext } from "react";

const CanvasConnectionContext = createContext<string | null>(null);

export const CanvasConnectionProvider = CanvasConnectionContext.Provider;

export function useCanvasConnection(): string {
  const id = useContext(CanvasConnectionContext);
  if (id === null) throw new Error("useCanvasConnection must be used inside a canvas.");
  return id;
}
