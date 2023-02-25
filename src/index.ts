import pg from "pg";
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

// Patches client so that unref works as expected... Node terminates
// only if there are not pending queries
const patchClient = (client: pg.Client) => {
  const connect = client.connect.bind(client);
  const query = client.query.bind(client);
  let refCount = 0;

  const ref = () => {
    refCount++;
    /* @ts-ignore */
    client.connection.stream.ref();
  };
  const unref = () => {
    refCount--;
    /* @ts-ignore */
    if (!refCount) client.connection.stream.unref();
  };

  const wrap =
    (fn: Function) =>
    (...args: []) => {
      ref();
      const lastArg = args[args.length - 1];
      const lastArgIsCb = typeof lastArg === "function";
      const outerCb = lastArgIsCb ? lastArg : noop;
      if (lastArgIsCb) args.pop();
      const cb = (...cbArgs: []) => {
        unref();
        outerCb(...cbArgs);
      };
      /* @ts-ignore */
      args.push(cb);
      return fn(...args);
    };

  client.connect = wrap(connect);
  client.query = wrap(query);
  return client;
};

type AdvisoryKey = [number, number];

const query = (client: pg.Client, lockFn: string, [key1, key2]: AdvisoryKey) =>
  new Promise((resolve, reject) => {
    const sql = `SELECT ${lockFn}(${key1}, ${key2})`;
    debug(`query: ${sql}`);
    client.query(sql, (err, result) => {
      if (err) {
        debug(err);
        return reject(err);
      }
      resolve(result.rows[0][lockFn]);
    });
  });

// Pauses promise chain until pg client is connected
const initWaitForConnection = (client: pg.Client) => {
  const queue: [(value?: any) => void, (err: any) => void][] = [];
  let waitForConnect = true;
  debug("connecting");

  client.connect((err) => {
    waitForConnect = false;
    if (err) {
      debug("connection error");
      debug(err);
      queue.forEach(([, reject]) => reject(err));
    } else {
      debug("connected");
      queue.forEach(([resolve]) => resolve());
    }
  });
  return () =>
    new Promise<void>((resolve, reject) => {
      if (!waitForConnect) return resolve();
      debug("waiting for connection");
      queue.push([resolve, reject]);
    });
};

interface FunctionObject {
  [key: string]: (...args: any[]) => any;
}

export default (conString: string) => {
  debug(`connection string: ${conString}`);
  const client = patchClient(new pg.Client(conString));
  const waitForConnection = initWaitForConnection(client);
  // TODO: client.connection.stream.unref()?

  const createMutex = (name: string) => {
    const key = typeof name === "string" ? strToKey(name) : name;

    const lock = () => query(client, "pg_advisory_lock", key);
    const unlock = () => query(client, "pg_advisory_unlock", key);
    const tryLock = () => query(client, "pg_try_advisory_lock", key);

    // TODO: catch db disconnection errors?
    const withLock = (fn: () => void) =>
      lock().then(() =>
        Promise.resolve()
          .then(fn)
          .then(
            (res) => unlock().then(() => res),
            (err) =>
              unlock().then(() => {
                throw err;
              })
          )
      );

    const fns: FunctionObject = { lock, unlock, tryLock, withLock };

    // "Block" function calls until client is connected
    const guardedFns: FunctionObject = {};
    Object.keys(fns).forEach((fnName) => {
      guardedFns[fnName] = (...args) =>
        waitForConnection().then(() => fns[fnName](...args));
    });
    return guardedFns;
  };
  createMutex.client = client;
  return createMutex;
};
