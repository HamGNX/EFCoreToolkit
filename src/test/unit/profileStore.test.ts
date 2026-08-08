import assert from "node:assert/strict";
import test from "node:test";
import {
  ProfileStore,
  type MementoLike,
  type SecretStorageLike,
} from "../../services/profileStore";

class MemoryMemento implements MementoLike {
  public readonly values = new Map<string, unknown>();
  public failUpdates = false;

  public get<T>(key: string, defaultValue: T): T {
    return (this.values.get(key) as T | undefined) ?? defaultValue;
  }

  public async update(key: string, value: unknown): Promise<void> {
    if (this.failUpdates) {
      throw new Error("metadata write failed");
    }
    this.values.set(key, value);
  }
}

class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();

  public async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  public async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  public async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const input = {
  name: "Orders",
  provider: "mysql" as const,
  outputFolder: "/repo/Models",
  dbContextName: "OrdersContext",
  connectionString: "Server=localhost;Password=secret;",
};

test("stores metadata separately from connection secret", async () => {
  const memento = new MemoryMemento();
  const secrets = new MemorySecrets();
  const store = new ProfileStore(memento, secrets, "file:///repo");

  const saved = await store.save(input);
  const serializedMetadata = JSON.stringify([...memento.values.values()]);

  assert.equal(serializedMetadata.includes(input.connectionString), false);
  assert.equal([...secrets.values.values()][0], input.connectionString);
  assert.deepEqual(await store.load(saved), { ...saved, connectionString: input.connectionString });
});

test("namespaces secrets by workspace", async () => {
  const memento = new MemoryMemento();
  const secrets = new MemorySecrets();
  const first = new ProfileStore(memento, secrets, "file:///repo-a");
  const second = new ProfileStore(memento, secrets, "file:///repo-b");

  await first.save(input);

  assert.equal(second.list().length, 0);
  assert.equal(secrets.values.size, 1);
});

test("rolls back secret when metadata write fails", async () => {
  const memento = new MemoryMemento();
  const secrets = new MemorySecrets();
  const store = new ProfileStore(memento, secrets, "file:///repo");
  memento.failUpdates = true;

  await assert.rejects(() => store.save(input), /metadata write failed/);
  assert.equal(secrets.values.size, 0);
});

test("deletes profile metadata and secret", async () => {
  const memento = new MemoryMemento();
  const secrets = new MemorySecrets();
  const store = new ProfileStore(memento, secrets, "file:///repo");
  const saved = await store.save(input);

  await store.delete(saved);

  assert.equal(store.list().length, 0);
  assert.equal(secrets.values.size, 0);
});

test("restores secret when profile metadata deletion fails", async () => {
  const memento = new MemoryMemento();
  const secrets = new MemorySecrets();
  const store = new ProfileStore(memento, secrets, "file:///repo");
  const saved = await store.save(input);
  memento.failUpdates = true;

  await assert.rejects(() => store.delete(saved), /metadata write failed/);

  assert.equal(secrets.values.size, 1);
  assert.deepEqual(await store.load(saved), { ...saved, connectionString: input.connectionString });
});
