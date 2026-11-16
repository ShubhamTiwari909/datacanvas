# Plan: searching tables from the sidebar

Status: **proposal for 1.4.0, nothing built.** Requested 2026-11-16 as part of the 1.4.0 release, alongside editing rows and designing tables (`docs/data-editing-plan.md`). It is independent of editing and small, so it can be built first.

## 1. Goal

Make a table easy to find in the sidebar. Today the sidebar lists schemas, and a schema's tables are loaded only when it is opened (`apps/web/features/explorer/schema-tree.tsx`). To find `order_items` in a database with many schemas and hundreds of tables, a person opens each schema and scrolls. The only search is the box in the canvas toolbar (`canvas-search.tsx`), which finds tables and columns anywhere in the database but works on the canvas, not on the sidebar list.

Add a **filter box at the top of the sidebar's schema tree**: typing narrows the tree to the tables and views whose name contains the text, and the schemas that hold a match open by themselves. Clicking a result does what clicking a table in the tree does today (selects it, and adds it to the canvas in the canvas view).

## 2. Non-goals

- Searching **columns** in the sidebar. The canvas search already does, and a sidebar list of tables is the wrong place for column hits.
- Searching **data**. Names only; no row is read and data viewing does not need to be on.
- Fuzzy matching, regular expressions, wildcards or saved searches.
- Remembering the text. It is held in the component and starts empty for each connection and each page load.
- A new API route or a change to any existing one (see the recommendation in section 3).

## 3. Design

**What it matches.** The same rules as the canvas search: case-insensitive "contains" on the table or view name, with `%` and `_` as ordinary characters (a plain `includes`, no pattern). Names that start with the text may be listed first.

**Where the names come from** (open decision 1). Tables are loaded one schema at a time, so a filter over the tree as it stands would miss every schema that has not been opened. Options:

- **(a) Filter only what is loaded.** Instant, no requests, but silently incomplete: a table in an unopened schema does not appear, which is the problem being solved.
- **(b) Load every schema's table list when the box is first used, then filter in the browser.** One request per schema in parallel, using `loadAllTables`, which the overview and the health checks already use. No new route, and the text never leaves the browser.
- **(c) Ask the server** with the existing `GET /api/connections/:id/search`. It is capped (20 hits), ranked, and returns columns too, which suits a dropdown, not a tree.

_Recommendation: (b)._ It is complete, adds no endpoint and sends the typed text nowhere. Cost: a first keystroke on a very large database waits for the lists to load, so the box shows "Loading tables…" and the work is measured in the milestone on a database with several thousand tables. If that is too slow, the fallback is (c) for the first result and (b) in the background.

**What the person sees.**

- A labelled search field above the tree, with a clear button; **Escape** clears it.
- While text is entered: schemas without a match are hidden, schemas with one are open, the matching part of each name is marked, and a short line says "3 of 120 tables".
- Nothing matches: "No table matches this text." The sentence does not repeat the text, in line with how the app words its other messages.
- The count is announced to screen readers (a polite live region); the field and the results are fully keyboard-operable.
- The blue "on the canvas" dot and the selected-table highlight work in the results exactly as in the tree.
- Switching to another connection starts with an empty box.

## 4. Security and privacy

- Names only, the same catalog data the tree already shows. No change to what is read, no change to the threat model's rows, and no row is touched, so it does not depend on data viewing.
- With (b) the text is used only in the browser: no request carries it, nothing logs it, and it is not stored or put in a URL. A browser test checks that typing sends no request containing the text.
- Names are rendered as text (never as HTML), including the marked match, which is built from split strings rather than from markup.

## 5. Testing plan

- **Unit (pure function):** case-insensitive contains; `%`, `_` and `\` are literal; accents and non-Latin names; names that start with the text first; empty text returns everything; a schema with no match is dropped.
- **Component:** schemas open for matches; the count and the empty message; Escape and the clear button; the selected table and the canvas dot survive filtering; a connection switch resets the box.
- **Browser (Playwright), against a real database:** a database with several schemas, one of them never opened, and a table in it that is found; clicking a result in canvas view adds it and in details view shows it; no request carries the text; an axe-core check in light and dark.
- **Measurement:** time to the first result on a database with several thousand tables (the decision in section 3 depends on it).

## 6. Milestone

|     | Milestone                                                                                                | Size | Done when                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| T0  | **Sidebar table search:** the filter function, the box in the schema tree, tests, measurement, the guide | S    | A table in an unopened schema is found and opened from the sidebar; `npm run check` and the browser tests pass; text never sent |

Order: it can be built before the editing milestones (E0 to E5), which keeps the 1.4.0 release useful even if editing takes longer. It needs no change to `SECURITY.md` or the threat model.

## 7. Documentation to update (in the same change)

- `docs/getting-started.md`: a line under the explorer description about the sidebar search.
- `README.md`: one phrase in the feature list.
- `docs/architecture.md`: the explorer section, one paragraph (the filter function and where the names come from).
- `docs/decisions.md`: the decision in section 3, and the entry that already records that this ships in 1.4.0.
- `CHANGELOG.md`: an entry in the 1.4.0 release.

## 8. Open decisions

1. **Where the names come from:** (a), (b) or (c) in section 3. _Recommendation: (b), with the measurement deciding whether the fallback is needed._
2. **Views and materialized views:** listed and searched like tables, as in the tree today. _Recommendation: yes, no separate switch._
3. **Columns in the sidebar search:** _Recommendation: no_, they stay in the canvas search.
4. **A keyboard shortcut to focus the box** (such as `/`). _Recommendation: not in the first version_; it can clash with typing elsewhere, and the field is one Tab away.
