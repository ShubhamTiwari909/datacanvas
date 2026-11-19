export * from "./types.js";
export * from "./classify.js";
export { planMigration, upScript, downScript } from "./plan.js";
export { suggestRenames, applyRenames } from "./rename.js";
export type { RenameSuggestion, RenameKind, RenameConfidence, AppliedRenames } from "./rename.js";
export {
  buildScripts,
  summarize,
  resolveSelection,
  commentOut,
  flattenComment,
  isDestructive,
} from "./script.js";
export type { Selection, Resolved, Scripts, Summary } from "./script.js";
