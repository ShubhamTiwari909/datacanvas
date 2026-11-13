/**
 * `workspaces/<id>.json`: one file per saved canvas layout.
 */
import { parseWorkspaceFile, workspaceIdSchema, type Workspace } from "@datacanvas/shared-types";
import fs from "node:fs/promises";
import path from "node:path";
import { guardStorage, ServiceError } from "../service-error";
import { KeyedMutex, readTextFile, writeFileAtomic } from "./atomic-file";

export class WorkspaceStorage {
  private readonly directory: string;
  private readonly mutex = new KeyedMutex();

  constructor(dataDir: string) {
    this.directory = path.join(dataDir, "workspaces");
  }

  /**
   * The file for an id, or null if the id is not a valid id.
   *
   * SECURITY: this is the only place an id becomes a path. The id pattern
   * allows no path characters, so the result is always directly inside the
   * workspaces folder, whatever the caller passed.
   */
  private fileFor(id: string): string | null {
    return workspaceIdSchema.safeParse(id).success ? path.join(this.directory, `${id}.json`) : null;
  }

  /** Every readable workspace. Damaged files are skipped (and counted), never deleted. */
  list(): Promise<{ workspaces: Workspace[]; skipped: number }> {
    return guardStorage(async () => {
      let names: string[];
      try {
        names = await fs.readdir(this.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { workspaces: [], skipped: 0 };
        throw error;
      }

      const workspaces: Workspace[] = [];
      let skipped = 0;
      // Only "<id>.json"; temporary ".xxx.tmp" files from an interrupted write are ignored.
      for (const name of names.filter((n) => n.endsWith(".json") && !n.startsWith("."))) {
        const workspace = await this.readFile(path.join(this.directory, name));
        if (workspace) workspaces.push(workspace);
        else skipped += 1;
      }
      return { workspaces, skipped };
    });
  }

  /**
   * One workspace, or null if there is none.
   * @throws ServiceError `invalid_workspace_file` if the file exists but is damaged.
   */
  get(id: string): Promise<Workspace | null> {
    const file = this.fileFor(id);
    if (!file) return Promise.resolve(null);
    return guardStorage(async () => {
      const text = await readTextFile(file);
      if (text === null) return null;
      const workspace = this.parse(text);
      if (!workspace) {
        throw new ServiceError(
          "invalid_workspace_file",
          "This workspace file is damaged and cannot be opened.",
        );
      }
      return workspace;
    });
  }

  put(workspace: Workspace): Promise<void> {
    const file = this.fileFor(workspace.id);
    if (!file)
      return Promise.reject(
        new ServiceError("workspace_not_found", "This workspace does not exist."),
      );
    return guardStorage(() =>
      this.mutex.run(file, () => writeFileAtomic(file, `${JSON.stringify(workspace, null, 2)}\n`)),
    );
  }

  /** Delete a workspace. Returns false if it did not exist. */
  remove(id: string): Promise<boolean> {
    const file = this.fileFor(id);
    if (!file) return Promise.resolve(false);
    return guardStorage(() =>
      this.mutex.run(file, async () => {
        try {
          await fs.unlink(file);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      }),
    );
  }

  private async readFile(file: string): Promise<Workspace | null> {
    const text = await readTextFile(file);
    return text === null ? null : this.parse(text);
  }

  private parse(text: string): Workspace | null {
    try {
      const parsed = parseWorkspaceFile(JSON.parse(text));
      return parsed.ok ? parsed.workspace : null;
    } catch {
      return null;
    }
  }
}
