---
title: Cloud databases and TLS
description: Connection string shapes, Google Cloud SQL, certificate verification, and the things DataCanvas cannot do for a private network.
---

DataCanvas connects over the network (TCP) to a host name or IP address. Paste the provider's connection
string, or fill in the fields. Accepted shapes:

```text
postgresql://user:password@host:5432/database
postgresql://user:password@/database?host=host.example.com&port=5432   (host in the query, as libpq writes it)
```

Add `?sslmode=require` or `?sslmode=verify-full` to choose the encryption (a remote host defaults to the
strictest, `verify-full`). Other parameters in the string (such as Prisma's `schema=`) are ignored on
purpose. A **local** address defaults to no extra SSL.

## Google Cloud SQL

A string with `?host=/cloudsql/PROJECT:REGION:INSTANCE` is the form used **inside** Google Cloud (Cloud
Run, App Engine) and cannot work from your computer: `/cloudsql/...` is a Unix socket that only exists
there. DataCanvas says so. Two ways in from your computer:

1. **Cloud SQL Auth Proxy** (recommended). Run it with the instance name (the part after `/cloudsql/`) and
   a local port, following Google's current instructions, then connect to
   `postgresql://user:password@127.0.0.1:<that port>/database`. A local address defaults to no extra SSL,
   which is right because the proxy encrypts.
2. **Public IP.** Enable a public IP on the instance, authorise your current IP in its networks, and use
   `postgresql://user:password@PUBLIC_IP:5432/database?sslmode=require`.

:::note
A proxy listens on `127.0.0.1`, so DataCanvas treats it as local, which matters for
[writes](/guides/editing/). Check the address in the unlock dialog.
:::

## Certificates

`verify-full` checks the server's certificate against the authorities **your Node.js trusts**. Providers
that sign with their own authority (Amazon RDS, Google Cloud SQL, Supabase direct connections) will fail
that check, and **DataCanvas cannot yet be given a CA file**. `sslmode=require` still encrypts but does
not verify who answers, so it is weaker on an untrusted network.

The TLS settings are always passed explicitly to the driver, so a `PGSSLMODE` environment variable cannot
weaken them.

## Other things to know

- A database reachable only inside a private network needs a **VPN or a tunnel** first (DataCanvas has no
  built-in tunnel).
- Serverless databases that sleep can take longer than the **10 second** connect timeout on the first
  try; try again.
- Short-lived IAM tokens work only if you paste a fresh one as the password.
- Poolers such as PgBouncer are supported by design (each operation is one short read-only transaction),
  but **none of these services has been tested against a real account**, and the project lists managed
  PostgreSQL services (RDS, Supabase, Neon, Azure) as untested. Self-hosted PostgreSQL 12 to 18 passes the
  project's tests.
- Use a read-only user.

---

**Sources:** [`docs/getting-started.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/getting-started.md) (Cloud databases),
[`docs/releasing.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/releasing.md) (Still open),
[`packages/shared-types/src/postgres-connection.ts`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/packages/shared-types/src/postgres-connection.ts),
[`docs/architecture.md`](https://github.com/ShubhamTiwari909/datacanvas/blob/main/docs/architecture.md) (Phase 5, Connection strings).
