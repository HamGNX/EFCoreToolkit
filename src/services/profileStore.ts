import { createHash, randomUUID } from "node:crypto";
import type { ConnectionProfile, ProfileMetadata } from "../types";

export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface SaveProfileInput {
  name: string;
  provider: "mysql";
  outputFolder: string;
  dbContextName: string;
  connectionString: string;
}

export class ProfileStore {
  private readonly workspaceHash: string;
  private readonly metadataKey: string;

  public constructor(
    private readonly workspaceState: MementoLike,
    private readonly secrets: SecretStorageLike,
    workspaceIdentity: string,
  ) {
    this.workspaceHash = createHash("sha256").update(workspaceIdentity).digest("hex").slice(0, 24);
    this.metadataKey = `profiles:${this.workspaceHash}`;
  }

  public list(): ProfileMetadata[] {
    return [...this.workspaceState.get<ProfileMetadata[]>(this.metadataKey, [])].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  public async save(input: SaveProfileInput): Promise<ProfileMetadata> {
    const profile: ProfileMetadata = {
      id: randomUUID(),
      name: input.name,
      provider: input.provider,
      outputFolder: input.outputFolder,
      dbContextName: input.dbContextName,
    };
    const secretKey = this.secretKey(profile.id);

    await this.secrets.store(secretKey, input.connectionString);
    try {
      await this.workspaceState.update(this.metadataKey, [...this.list(), profile]);
    } catch (error) {
      await this.secrets.delete(secretKey);
      throw error;
    }

    return profile;
  }

  public async load(profile: ProfileMetadata): Promise<ConnectionProfile | undefined> {
    const connectionString = await this.secrets.get(this.secretKey(profile.id));
    return connectionString === undefined ? undefined : { ...profile, connectionString };
  }

  public async delete(profile: ProfileMetadata): Promise<void> {
    const remaining = this.list().filter((candidate) => candidate.id !== profile.id);
    const secretKey = this.secretKey(profile.id);
    const connectionString = await this.secrets.get(secretKey);
    await this.secrets.delete(secretKey);
    try {
      await this.workspaceState.update(this.metadataKey, remaining);
    } catch (error) {
      if (connectionString !== undefined) {
        await this.secrets.store(secretKey, connectionString);
      }
      throw error;
    }
  }

  private secretKey(profileId: string): string {
    return `connection:${this.workspaceHash}:${profileId}`;
  }
}
