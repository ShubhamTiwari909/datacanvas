/**
 * The form for connecting to PostgreSQL: paste a connection string, or fill in
 * the fields. Two buttons: "Test connection" (checks, saves nothing) and
 * "Connect" (also remembers the connection on the server).
 *
 * Validation happens twice on purpose: here, with the shared Zod schema, for
 * instant feedback; and on the server with the same schema, because browser
 * checks can be bypassed and the server must never trust them.
 *
 * SECURITY: the password and connection string live only in this component's
 * state while the form is open; they are sent once to the server and never
 * stored in the browser (not in the store, localStorage or the URL).
 */
"use client";

import { useState, type FormEvent } from "react";
import { CheckCircle2, Eye, EyeOff, Loader2 } from "lucide-react";
import {
  defaultSslMode,
  type ConnectionProfile,
  postgresConnectionInputSchema,
  type ConnectionSummary,
  type PostgresSslMode,
  type ValidationIssue,
} from "@datacanvas/shared-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { createConnection, testConnection } from "./api";

type Mode = "string" | "fields";
type Action = "test" | "connect";
type FieldErrors = Record<string, string>;
type SslChoice = "auto" | PostgresSslMode;

const SSL_OPTIONS: Array<{ value: PostgresSslMode; label: string }> = [
  { value: "disable", label: "Off: for databases on this computer" },
  { value: "require", label: "Encrypted, certificate not checked" },
  { value: "verify-full", label: "Encrypted and verified (recommended)" },
];

/** Keep the first message per top-level field name. */
function toFieldErrors(issues: ValidationIssue[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const field = issue.path.split(".")[0];
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}

function FieldMessage({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  );
}

/** A text input with a label and an optional error message wired up for screen readers. */
function Field({
  id,
  label,
  error,
  className,
  ...inputProps
}: { id: string; label: string; error?: string } & React.ComponentProps<"input">) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...inputProps}
      />
      <FieldMessage id={`${id}-error`} message={error} />
    </div>
  );
}

/** A masked input with a show/hide toggle (used for secrets). */
function SecretField({
  id,
  label,
  error,
  ...inputProps
}: { id: string; label: string; error?: string } & Omit<React.ComponentProps<"input">, "type">) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          type={reveal ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          {...inputProps}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setReveal((r) => !r)}
          aria-label={reveal ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        >
          {reveal ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </Button>
      </div>
      <FieldMessage id={`${id}-error`} message={error} />
    </div>
  );
}

export function ConnectionForm({
  onConnected,
  initial,
}: {
  onConnected: (connection: ConnectionSummary) => void;
  /**
   * A SAVED connection being reconnected. Its saved details fill the form, so
   * only the password (which is never saved) has to be typed.
   */
  initial?: ConnectionProfile;
}) {
  const [mode, setMode] = useState<Mode>(initial ? "fields" : "string");
  const [name, setName] = useState(initial?.name ?? "");
  const [connectionString, setConnectionString] = useState("");
  const [host, setHost] = useState(initial?.host ?? "localhost");
  const [port, setPort] = useState(String(initial?.port ?? 5432));
  const [database, setDatabase] = useState(initial?.database ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState("");
  const [ssl, setSsl] = useState<SslChoice>(initial?.sslMode ?? "auto");
  // Offered for NEW connections: keep host, database and user (never the password) for next time.
  const [remember, setRemember] = useState(true);
  // Reading the rows of tables is off unless the person turns it on (a saved connection brings its own setting back).
  const [dataAccess, setDataAccess] = useState(initial?.dataAccess ?? false);

  const [busy, setBusy] = useState<Action | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  /** The request body for the current mode, or field errors if the port is not a number. */
  function buildInput(action: Action): { input: unknown } | { errors: FieldErrors } {
    // What to do with the connection once it works. A reconnected profile is linked; a new one is saved if asked.
    const persistence =
      action === "connect"
        ? { ...(initial ? { profileId: initial.id } : { remember }), dataAccess }
        : {};
    if (mode === "string")
      return { input: { mode: "string", name, connectionString, ...persistence } };
    if (port.trim() !== "" && !/^\d+$/.test(port.trim())) {
      return { errors: { port: "Port must be a whole number." } };
    }
    return {
      input: {
        mode: "fields",
        name,
        host,
        ...(port.trim() !== "" ? { port: Number(port) } : {}),
        database,
        username,
        password,
        ...(ssl !== "auto" ? { sslMode: ssl } : {}),
        ...persistence,
      },
    };
  }

  async function run(action: Action) {
    setFormError(null);
    setSuccess(null);

    const built = buildInput(action);
    if ("errors" in built) return setFieldErrors(built.errors);

    // Step 1: browser-side validation with the shared schema.
    const local = postgresConnectionInputSchema.safeParse(built.input);
    if (!local.success) {
      return setFieldErrors(
        toFieldErrors(
          local.error.issues.map((i) => ({
            path: i.path.map(String).join("."),
            message: i.message,
          })),
        ),
      );
    }
    setFieldErrors({});

    // Step 2: the server validates again, then actually tries the database.
    setBusy(action);
    const result =
      action === "test" ? await testConnection(built.input) : await createConnection(built.input);
    setBusy(null);

    if (!result.ok) {
      const errors = toFieldErrors(result.error.issues);
      setFieldErrors(errors);
      if (Object.keys(errors).length === 0) setFormError(result.error.message);
      return;
    }
    if (action === "test") setSuccess("Connection successful. Nothing was saved.");
    else onConnected(result.data as ConnectionSummary);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); // we submit with fetch, not a page reload
    void run("connect"); // pressing Enter connects
  }

  const effectiveSsl = ssl === "auto" ? defaultSslMode(host.trim()) : ssl;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      {initial ? (
        <p className="rounded-md border bg-muted p-3 text-sm">
          Reconnecting <strong>{initial.name}</strong>. DataCanvas saved where this database is, but
          never the password: enter it to connect. Your saved layouts will open again.
        </p>
      ) : null}
      <Field
        id="connection-name"
        label="Connection name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="My database"
        error={fieldErrors.name}
      />

      <div role="tablist" aria-label="How to enter the connection" className="flex gap-1">
        {(["string", "fields"] as const).map((value) => (
          <Button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            variant={mode === value ? "secondary" : "ghost"}
            size="sm"
            onClick={() => {
              setMode(value);
              setFieldErrors({});
              setFormError(null);
              setSuccess(null);
            }}
          >
            {value === "string" ? "Connection string" : "Fields"}
          </Button>
        ))}
      </div>

      {mode === "string" ? (
        <SecretField
          id="connection-string"
          label="Connection string"
          value={connectionString}
          onChange={(e) => setConnectionString(e.target.value)}
          placeholder="postgresql://user:password@host:5432/database"
          error={fieldErrors.connectionString}
        />
      ) : (
        <>
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <Field
              id="connection-host"
              label="Host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              error={fieldErrors.host}
            />
            <Field
              id="connection-port"
              label="Port"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              error={fieldErrors.port}
            />
          </div>
          <Field
            id="connection-database"
            label="Database"
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            error={fieldErrors.database}
          />
          <Field
            id="connection-username"
            label="User name"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            error={fieldErrors.username}
          />
          <SecretField
            id="connection-password"
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={fieldErrors.password}
          />
          <div className="flex flex-col gap-2">
            <Label htmlFor="connection-ssl">Encryption (SSL)</Label>
            <select
              id="connection-ssl"
              value={ssl}
              onChange={(e) => setSsl(e.target.value as SslChoice)}
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            >
              <option value="auto">
                Automatic (
                {effectiveSsl === "disable" ? "off for this computer" : "encrypted and verified"})
              </option>
              {SSL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      <p className="text-xs text-muted-foreground">
        By default DataCanvas reads only the structure of your database. A read-only database user
        is still the safest choice. Credentials stay on this machine, in memory.
      </p>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4"
          checked={dataAccess}
          onChange={(e) => setDataAccess(e.target.checked)}
        />
        <span>
          Allow viewing table data
          <span className="block text-xs text-muted-foreground">
            Off by default. When on, DataCanvas reads and shows the rows of tables you open,
            read-only. Rows are never saved.
          </span>
        </span>
      </label>

      {!initial ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>
            Save this connection for next time
            <span className="block text-xs text-muted-foreground">
              Keeps the host, database and user name on this computer so your layouts can be
              reopened. The password is never saved.
            </span>
          </span>
        </label>
      ) : null}

      {formError ? (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      ) : null}
      {success ? (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400"
        >
          <CheckCircle2 className="size-4" aria-hidden="true" />
          {success}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void run("test")}
        >
          {busy === "test" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Test connection
        </Button>
        <Button type="submit" disabled={busy !== null}>
          {busy === "connect" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Connect
        </Button>
      </div>
    </form>
  );
}
