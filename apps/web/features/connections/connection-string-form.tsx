/**
 * Form for pasting a PostgreSQL connection string.
 *
 * Phase 3 scope: it validates the input and shows what DataCanvas understood.
 * It does NOT connect to a database yet (Phase 6 adds Test Connection and the
 * fields-based form).
 *
 * Validation happens twice on purpose:
 *   1. In the browser, with the shared Zod schema, for instant feedback.
 *   2. On the server, with the same schema, because browser checks can be
 *      bypassed and the server must never trust them.
 */
"use client";

import { useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import {
  postgresConnectionInputSchema,
  type PostgresConnectionSummary,
  type ValidationIssue,
} from "@datacanvas/shared-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { validateConnection } from "./api";

type FieldName = "name" | "connectionString";
type FieldErrors = Partial<Record<FieldName, string>>;

/** Group a flat issue list by form field; keep the first message per field. */
function issuesToFieldErrors(issues: ValidationIssue[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const field = issue.path.split(".").pop();
    if ((field === "name" || field === "connectionString") && !errors[field]) {
      errors[field] = issue.message;
    }
  }
  return errors;
}

export function ConnectionStringForm() {
  const [name, setName] = useState("");
  const [connectionString, setConnectionString] = useState("");
  // The connection string usually contains the password, so it is masked by default.
  const [reveal, setReveal] = useState(false);
  const [checking, setChecking] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<PostgresConnectionSummary | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); // stay on the page; we handle the submit ourselves
    setFormError(null);
    setResult(null);

    const input = { mode: "string", name, connectionString };

    // Step 1: browser-side validation with the shared schema.
    const local = postgresConnectionInputSchema.safeParse(input);
    if (!local.success) {
      setFieldErrors(
        issuesToFieldErrors(
          local.error.issues.map((i) => ({
            path: i.path.map(String).join("."),
            message: i.message,
          })),
        ),
      );
      return;
    }
    setFieldErrors({});

    // Step 2: the server validates again and returns a password-free summary.
    setChecking(true);
    const response = await validateConnection(input);
    setChecking(false);

    if (response.ok) {
      setResult(response.connection);
      return;
    }
    const errors = issuesToFieldErrors(response.issues);
    setFieldErrors(errors);
    // Show the general message only when no field-level message explains it.
    if (Object.keys(errors).length === 0) setFormError(response.message);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-2">
        <Label htmlFor="connection-name">Connection name</Label>
        <Input
          id="connection-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My database"
          aria-invalid={fieldErrors.name ? true : undefined}
          aria-describedby={fieldErrors.name ? "connection-name-error" : undefined}
        />
        {fieldErrors.name ? (
          <p id="connection-name-error" className="text-sm text-destructive">
            {fieldErrors.name}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="connection-string">Connection string</Label>
        <div className="flex gap-2">
          <Input
            id="connection-string"
            type={reveal ? "text" : "password"}
            value={connectionString}
            onChange={(e) => setConnectionString(e.target.value)}
            placeholder="postgresql://user:password@host:5432/database"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={fieldErrors.connectionString ? true : undefined}
            aria-describedby={fieldErrors.connectionString ? "connection-string-error" : undefined}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setReveal((r) => !r)}
            aria-label={reveal ? "Hide connection string" : "Show connection string"}
          >
            {reveal ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </Button>
        </div>
        {fieldErrors.connectionString ? (
          <p id="connection-string-error" className="text-sm text-destructive">
            {fieldErrors.connectionString}
          </p>
        ) : null}
      </div>

      {formError ? (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      ) : null}

      {result ? (
        <div role="status" className="rounded-md border bg-muted p-3 text-sm">
          <p className="font-medium">The connection string looks valid.</p>
          <p className="text-muted-foreground">
            {result.username}@{result.host}:{result.port}/{result.database} · TLS: {result.sslMode}{" "}
            · password {result.hasPassword ? "provided" : "not provided"}
          </p>
          <p className="mt-1 text-muted-foreground">
            No connection was made. Connecting to the database arrives in a later phase.
          </p>
        </div>
      ) : null}

      <Button type="submit" disabled={checking}>
        {checking ? "Checking…" : "Check connection string"}
      </Button>
    </form>
  );
}
