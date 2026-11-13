/**
 * Saved workspaces (canvas layouts): list, load, save, delete, export, import.
 */
import {
  CURRENT_WORKSPACE_VERSION,
  parseWorkspaceFile,
  summarizeWorkspace,
  toExportedWorkspace,
  WORKSPACE_FORMAT,
  type Workspace,
  type WorkspaceInput,
  type WorkspaceSummary,
} from "@datacanvas/shared-types";
import { randomBytes } from "node:crypto";
import { ServiceError } from "./service-error";
import type { ProfileStorage } from "./storage/profile-storage";
import type { WorkspaceStorage } from "./storage/workspace-storage";

/** At most this many workspaces are kept, which bounds disk use. */
export const MAX_WORKSPACES = 500;

export interface WorkspaceServiceDependencies {
  workspaces: WorkspaceStorage;
  profiles: ProfileStorage;
  now?: () => Date;
}

/** A file name for an exported workspace: letters, digits and a few safe symbols only. */
export function exportFileName(workspaceName: string): string {
  const safe = workspaceName
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .trim()
    .slice(0, 60);
  return `${safe === "" ? "workspace" : safe}.datacanvas.json`;
}

export class WorkspaceService {
  private readonly workspaces: WorkspaceStorage;
  private readonly profiles: ProfileStorage;
  private readonly now: () => Date;

  constructor(dependencies: WorkspaceServiceDependencies) {
    this.workspaces = dependencies.workspaces;
    this.profiles = dependencies.profiles;
    this.now = dependencies.now ?? (() => new Date());
  }

  /** Summaries, most recently changed first; optionally only those of one saved connection. */
  async list(profileId?: string): Promise<WorkspaceSummary[]> {
    const { workspaces } = await this.workspaces.list();
    return workspaces
      .filter((w) => profileId === undefined || w.profileId === profileId)
      .map(summarizeWorkspace)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** @throws ServiceError `workspace_not_found`, or `invalid_workspace_file` for a damaged file. */
  async get(id: string): Promise<Workspace> {
    const workspace = await this.workspaces.get(id);
    if (!workspace) throw new ServiceError("workspace_not_found", "This workspace does not exist.");
    return workspace;
  }

  /**
   * Create or update the workspace `id`. The client supplies the content; the
   * server owns the id and the timestamps (`createdAt` is kept on updates).
   */
  async save(id: string, input: WorkspaceInput): Promise<Workspace> {
    await this.requireProfile(input.profileId);

    const existing = await this.workspaces.get(id).catch((error: unknown) => {
      // A damaged file under this id is replaced by a good save: that is how it gets repaired.
      if (error instanceof ServiceError && error.code === "invalid_workspace_file") return null;
      throw error;
    });
    if (!existing) await this.requireRoom();

    const timestamp = this.now().toISOString();
    const workspace: Workspace = {
      format: WORKSPACE_FORMAT,
      schemaVersion: CURRENT_WORKSPACE_VERSION,
      id,
      name: input.name,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      profileId: input.profileId,
      connectionHint: input.connectionHint,
      canvas: input.canvas,
    };
    await this.workspaces.put(workspace);
    return workspace;
  }

  /** @throws ServiceError `workspace_not_found` */
  async remove(id: string): Promise<void> {
    if (!(await this.workspaces.remove(id))) {
      throw new ServiceError("workspace_not_found", "This workspace does not exist.");
    }
  }

  /** The file content to hand to the user, and a safe name for it. */
  async exportFile(id: string): Promise<{ fileName: string; content: Workspace }> {
    const workspace = await this.get(id);
    return { fileName: exportFileName(workspace.name), content: toExportedWorkspace(workspace) };
  }

  /**
   * Import a workspace from the content of an exported file (untrusted JSON).
   * It is upgraded to the current format, validated, and saved under a NEW id
   * (an import never overwrites an existing workspace), attached to `profileId`.
   *
   * @throws ServiceError `invalid_workspace_file`
   */
  async importFile(raw: unknown, profileId: string | null): Promise<Workspace> {
    const parsed = parseWorkspaceFile(raw);
    if (!parsed.ok) throw new ServiceError("invalid_workspace_file", parsed.message);

    return this.save(randomBytes(12).toString("base64url"), {
      name: parsed.workspace.name,
      profileId,
      connectionHint: parsed.workspace.connectionHint,
      canvas: parsed.workspace.canvas,
    });
  }

  private async requireProfile(profileId: string | null): Promise<void> {
    if (profileId === null) return;
    if (!(await this.profiles.list()).some((p) => p.id === profileId)) {
      throw new ServiceError("profile_not_found", "This saved connection does not exist.");
    }
  }

  private async requireRoom(): Promise<void> {
    const { workspaces } = await this.workspaces.list();
    if (workspaces.length >= MAX_WORKSPACES) {
      throw new ServiceError(
        "workspace_limit_reached",
        `At most ${MAX_WORKSPACES} workspaces can be saved. Delete some first.`,
      );
    }
  }
}
