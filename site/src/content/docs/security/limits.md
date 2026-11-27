---
title: Known limits
description: What DataCanvas does not defend against, taken from the project's own security notes.
---

These are the project's stated limits at 1.13.0. They are not a complete list of everything that could go
wrong; they are what the maintainers have written down.

## The machine and the browser

- Another program running as **your user** can read the process list and so the token. DataCanvas does not
  defend against an attacker who already has your account.
- The token travels over plain `http` on loopback. Other users on a shared machine cannot normally see
  loopback traffic, but this is not hardened against a hostile administrator.
- Cookies are not isolated by port; other web apps on `127.0.0.1` receive the cookie. The Origin and
  `Sec-Fetch-Site` checks stop them from using it from a browser.
- The **Content-Security-Policy** (1.10.0) allows inline styles (the canvas and the menus set `style`
  attributes, which a nonce cannot cover), and `'strict-dynamic'` lets a script that already runs add
  scripts: markup that the parser reads cannot run, but a script that is already running is trusted.
- Passwords live in memory, so they are present in a memory dump of the process. So are the rows of any page
  you have open, in the server and in your browser, and they can end up in the operating system's swap.
- **Browser extensions** with access to the page can read what the page shows, including rows.
- Two DataCanvas processes sharing one data folder are not coordinated.

## Reading data

- Hiding columns by name is a **hint, not a control**.
- Row-level security can silently return fewer rows; the Data section says so only when it applies to your
  role.
- A sort or condition can make the database scan a whole table. Such reads are stopped after 5 seconds and
  run one at a time per connection, but each try can still cost the database up to 5 seconds of work.
- A condition's value is held in memory and sent in a request body; like rows, it is never saved, logged or
  put in an error.
- A file you **export** is yours: DataCanvas cannot protect it after your browser saved it, and a column
  whose name does not look sensitive can still hold a secret.

## Letting Claude read a connection (1.11.0)

- **What Claude reads is sent to Anthropic by the Claude app**, and DataCanvas cannot stop that or take it
  back. Share only what may leave your machine.
- A **prompt-injected or hostile model** can ask for any rows you approve. A value in a table can say
  anything, and a model may read it as an instruction. Read what you approve; the approval prompt and the
  database user are the controls.
- **Hidden columns are a hint:** `SELECT *` returns such a column as NULL, but a whole-row value
  (`row_to_json(t)`) carries it inside one value.
- A database's own error text is withheld except for errors about names, time and limits.
- Another program running as you can read `mcp.json` and use the door while a connection is shared; it
  cannot approve calls or change the sharing.
- A superuser, or a role that can read server files or run programs, can do outside a read-only transaction
  what it does not stop: use a read-only database user.
- The approval prompt and Pause are guards against a distracted model, not against someone who holds the
  session token.

## Statistics, plans and INSERT scripts (1.10.0)

- A column's null share and distinct count are metadata, but they say something about the data.
- A plan of many thousands of steps takes a moment to draw (the steps beyond the first levels start
  collapsed); a plan larger than 2 MB is refused.
- A script of INSERT statements is text you run: run it in a test copy first. A file you export is yours.
- A text diagram from **Export documentation** shows names that can reveal how your system works.

## The SQL tab

- It runs what a role is allowed to run: a function with effects outside the database (through an extension
  such as `dblink`, or a privileged role) is not stopped by a read-only transaction.
- A statement can change its own time limits for the rest of its transaction, which only matters to the few
  queries run after it.
- A pooler such as PgBouncer can make Cancel reach the wrong session.

## Writes, validation, import

- With writes unlocked, **anyone holding the session token can change that local database**. Lock writes,
  or start without `--enable-writes`, when you are done.
- A tunnel or proxy on `127.0.0.1` to a remote database counts as local.
- A change can wait up to 3 seconds for a lock; once it has the lock, a long `ALTER TABLE` blocks other
  queries on the table.
- **Validation** writes only a temporary table, but takes up to 100,000 rows now and works on a connection
  that is not local and without the unlock. It is not free of side effects: **event triggers** fire when its
  temporary copy is made, and a CHECK function with outside effects is not stopped by the rollback.
- An **import or bulk change** can affect up to 100,000 rows in one transaction. Database triggers can run during apply. In an upsert, insert triggers can run for rows that are updated too. DataCanvas cannot undo a committed import.
- Triggers on a table run when you change a row and can do anything their code does. The preview names them.

## Migrations and snapshots

- A destructive step you leave unconfirmed is written commented out, and so is every later step that needs
  it or is about the same object. Steps that only touch other things still run.
- A migration is as good as the structure it was made from. A structure read while another migration runs
  can mix before and after, and a migration made from an old snapshot may not fit the database it is run on.
  Run it in a test copy when you can.

## Project-level gaps (from the maintainers' notes)

- No independent security review.
- Managed PostgreSQL services (RDS, Supabase, Neon, Azure) are untested; self-hosted PostgreSQL 12 to 18
  passes the project's tests.
- The CI workflow had its first run only recently; Windows and Linux were never tested by hand (per
  `docs/releasing.md`).
- A `kill -9` of the CLI leaves the server running until stopped by hand; two simultaneous first launches
  can race (per `docs/architecture.md`, Phase 11, which may be dated).

## Reporting a problem

Report vulnerabilities **privately** through GitHub's private vulnerability reporting on the repository
(the **Security** tab, then **Report a vulnerability**). Do not open a public issue with exploit details.
For legal, HR or security-policy questions about using DataCanvas in your organisation, confirm with the
relevant internal team; this documentation gives general guidance only.

---

**Sources:** [`SECURITY.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/SECURITY.md) (Known limits),
[`docs/threat-model.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/threat-model.md) (sections 12 and 13, Not covered),
[`docs/releasing.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/releasing.md) (Still open).
