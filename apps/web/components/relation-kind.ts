/**
 * How each kind of relation is named and drawn, in ONE place. Every screen
 * (schema tree, canvas node, inspector, search, details) imports these, so a
 * new kind of relation is one entry here and the compiler (these are
 * `Record<RelationKind, ...>`) points at anything that forgets it.
 */
import type { RelationKind } from "@datacanvas/database-core";
import { ExternalLink, Eye, Layers, Table2, type LucideIcon } from "lucide-react";

export const KIND_LABEL: Record<RelationKind, string> = {
  table: "Table",
  view: "View",
  materialized_view: "Materialized view",
  foreign_table: "Foreign table",
};

export const KIND_ICON: Record<RelationKind, LucideIcon> = {
  table: Table2,
  view: Eye,
  materialized_view: Layers,
  // "Lives somewhere else": the rows are read through another server or file.
  foreign_table: ExternalLink,
};
