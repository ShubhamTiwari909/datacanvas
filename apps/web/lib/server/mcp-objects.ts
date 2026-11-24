/**
 * The objects of a database (views, types, sequences, functions, triggers, extensions, policies) as Claude gets them
 * through `list_objects`: names and settings only. Every piece of DEFINITION TEXT is left out, because it can hold the
 * very values Claude must not see (a literal in a view, a password in a function body, a constant in a policy, a
 * domain's default): view SQL, function and trigger definitions, domain defaults and checks, and policy expressions.
 * Sequence settings are kept; a sequence's current value is never read by the adapter in the first place.
 */
import { isSensitiveColumnName, type DatabaseObjects } from "@datacanvas/database-core";

/** The most objects one call returns (all kinds together). */
export const MAX_OBJECTS = 2000;

export function shapeObjects(objects: DatabaseObjects, schema?: string) {
  const inSchema = <T extends { schema: string }>(list: T[]): T[] =>
    schema === undefined ? list : list.filter((o) => o.schema === schema);
  return {
    views: inSchema(objects.views).map((v) => ({
      schema: v.schema,
      name: v.name,
      materialized: v.materialized,
      comment: v.comment,
      dependsOn: v.dependsOn,
    })),
    types: inSchema(objects.types).map((t) => ({
      schema: t.schema,
      name: t.name,
      kind: t.kind,
      comment: t.comment,
      values: t.values,
      attributes: t.attributes.map((a) => ({
        name: a.name,
        dataType: a.dataType,
        hidden: isSensitiveColumnName(a.name),
      })),
      baseType: t.baseType,
    })),
    sequences: inSchema(objects.sequences).map((s) => ({
      schema: s.schema,
      name: s.name,
      dataType: s.dataType,
      start: s.start,
      increment: s.increment,
      min: s.min,
      max: s.max,
      cycle: s.cycle,
      ownedBy: s.ownedBy,
    })),
    functions: inSchema(objects.functions).map((f) => ({
      schema: f.schema,
      name: f.name,
      kind: f.kind,
      arguments: f.arguments,
      returns: f.returns,
      language: f.language,
      volatility: f.volatility,
      securityDefiner: f.securityDefiner,
      comment: f.comment,
    })),
    triggers: inSchema(objects.triggers).map((t) => ({
      schema: t.schema,
      table: t.table,
      name: t.name,
      timing: t.timing,
      events: t.events,
      level: t.level,
      function: t.function,
      state: t.state,
    })),
    extensions: inSchema(objects.extensions).map((e) => ({
      name: e.name,
      version: e.version,
      schema: e.schema,
      comment: e.comment,
    })),
    policies: inSchema(objects.policies).map((p) => ({
      schema: p.schema,
      table: p.table,
      name: p.name,
      command: p.command,
      permissive: p.permissive,
      roles: p.roles,
    })),
    rowSecurity: inSchema(objects.rowSecurity).map((r) => ({
      schema: r.schema,
      table: r.table,
      forced: r.forced,
    })),
  };
}
