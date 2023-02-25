import pg, { Pool } from "pg";
import { createHash } from "crypto";
import initDebug from "debug";

const debug = initDebug("advisory-lock");
const noop = () => {};

// Converts string to 64 bit number for use with postgres advisory lock
// functions
export const strToKey = (name: string): AdvisoryKey => {
  // TODO: detect "in process" collisions?
  // Generate sha256 hash of name
  // and take 32 bit twice from hash
  const buf = createHash("sha256").update(name).digest();
  // Read the first 4 bytes and the next 4 bytes
  // The parameter here is the byte offset, not the sizeof(int32) offset
  return [buf.readInt32LE(0), buf.readInt32LE(4)];
};

// TODO: fix unref?

type AdvisoryKey = [number, number];

async function query(
  client: pg.Client,
  lockFn: string,
  [key1, key2]: AdvisoryKey
): Promise<boolean> {
  const sql = `SELECT ${lockFn}(${key1}, ${key2})`;
  debug(`query: ${sql}`);
  const result = await client.query(sql);
  return result.rows[0][lockFn] as boolean;
}

interface CreateMutexFunction {
  (lockName: string): AdvisoryLock;
}

type WithLockFunction = (fn: () => Promise<unknown>) => Promise<unknown>;

type UnlockFn = () => Promise<void>;

interface AdvisoryLock {
  lock: () => Promise<UnlockFn>;
  unlock: UnlockFn;
  tryLock: () => Promise<UnlockFn | undefined>;
  withLock: WithLockFunction;
}

export default (conString: string): CreateMutexFunction => {
  debug(`connection string: ${conString}`);

  const createMutex: CreateMutexFunction = (name: string) => {
    const key = typeof name === "string" ? strToKey(name) : name;

    async function newClient(): Promise<pg.Client> {
      const client = new pg.Client({
        connectionString: conString,
      });
      await client.connect();
      return client;
    }

    // for backwards compatibility...
    let cachedUnlock: undefined | UnlockFn;
    async function unlock() {
      if (cachedUnlock) {
        return cachedUnlock();
      }
      // no op
    }

    // lock and unlock share a client because the lock is tied to a connection
    async function lock(): Promise<UnlockFn> {
      const client = await newClient();
      try {
        await query(client, "pg_advisory_lock", key);
        // For backwards compatibility we assign it to unlock
        const unlockFn = async function unlock() {
          try {
            await query(client, "pg_advisory_unlock", key);
          } finally {
            client.end();
          }
        };
        cachedUnlock = unlockFn;
        return unlockFn;
      } catch (err) {
        client.end();
        throw err;
      }
    }

    async function tryLock() {
      const client = await newClient();
      try {
        const obtained = await query(client, "pg_try_advisory_lock", key);
        if (obtained) {
          // For backwards compatibility we assign it to unlock
          const unlockFn = async function unlock() {
            try {
              await query(client, "pg_advisory_unlock", key);
            } finally {
              client.end();
            }
          };
          cachedUnlock = unlockFn;
          return unlockFn;
        } else {
          client.end();
        }
      } catch (err) {
        client.end();
        throw err;
      }
    }

    // TODO: catch db disconnection errors?
    const withLock: WithLockFunction = async function (fn = async () => {}) {
      const unlock = await lock();
      try {
        return await fn();
      } finally {
        await unlock();
      }
    };

    return { lock, unlock, tryLock, withLock };
  };
  return createMutex;
};
