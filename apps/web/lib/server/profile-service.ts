/**
 * Saved connection profiles: listing, creating (without duplicates) and
 * forgetting. Forgetting a profile also deletes the workspaces that belong to it.
 */
import type { ConnectionProfile } from "@datacanvas/shared-types";
import { randomBytes } from "node:crypto";
import { ServiceError } from "./service-error";
import type { ProfileStorage } from "./storage/profile-storage";
import type { WorkspaceStorage } from "./storage/workspace-storage";

/** A profile before it has an id and a creation time. */
export type NewProfile = Omit<ConnectionProfile, "id" | "createdAt">;

export class ProfileService {
  private readonly profiles: ProfileStorage;
  private readonly workspaces: WorkspaceStorage;
  private readonly now: () => Date;

  constructor(dependencies: {
    profiles: ProfileStorage;
    workspaces: WorkspaceStorage;
    now?: () => Date;
  }) {
    this.profiles = dependencies.profiles;
    this.workspaces = dependencies.workspaces;
    this.now = dependencies.now ?? (() => new Date());
  }

  list(): Promise<ConnectionProfile[]> {
    return this.profiles.list();
  }

  /** @throws ServiceError `profile_not_found` */
  async get(id: string): Promise<ConnectionProfile> {
    const profile = (await this.profiles.list()).find((p) => p.id === id);
    if (!profile)
      throw new ServiceError("profile_not_found", "This saved connection does not exist.");
    return profile;
  }

  /**
   * Save a profile. If the SAME database (provider, host, port, database and
   * user) is already saved, that profile is returned instead of a duplicate.
   */
  async add(details: NewProfile): Promise<ConnectionProfile> {
    const existing = (await this.profiles.list()).find(
      (p) =>
        p.provider === details.provider &&
        p.host === details.host &&
        p.port === details.port &&
        p.database === details.database &&
        p.username === details.username,
    );
    if (existing) return existing;

    const profile: ConnectionProfile = {
      ...details,
      id: randomBytes(12).toString("base64url"), // 16 URL-safe characters, unguessable
      createdAt: this.now().toISOString(),
    };
    await this.profiles.add(profile);
    return profile;
  }

  /**
   * Forget a profile and delete the workspaces saved for it.
   * @throws ServiceError `profile_not_found`
   */
  async remove(id: string): Promise<void> {
    if (!(await this.profiles.remove(id))) {
      throw new ServiceError("profile_not_found", "This saved connection does not exist.");
    }
    const { workspaces } = await this.workspaces.list();
    for (const workspace of workspaces.filter((w) => w.profileId === id)) {
      await this.workspaces.remove(workspace.id);
    }
  }
}
