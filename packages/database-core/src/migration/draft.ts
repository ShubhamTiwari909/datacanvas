/** What a step is made of before it has an id, and the keys the planner joins things by. */
import type { Reversibility, Risk, StepKind, StepObject } from "./types.js";

export const SEP = "\u0001";
export const tableKey = (schema: string, name: string): string => `${schema}${SEP}${name}`;

export interface Draft {
  kind: StepKind;
  object: StepObject;
  up: string;
  down: string | null;
  risk?: Risk[];
  reversibility?: Reversibility;
  transactional?: boolean;
  dependsOn?: string[];
  note: string;
  /** Tables made in this plan that the step needs (resolved to step ids when the steps are numbered). */
  dependsOnTable?: string;
  alsoDependsOnTable?: string;
  /** A key this step makes, and the keys it needs made first (views, functions, types). */
  provides?: string;
  needs?: string[];
}
