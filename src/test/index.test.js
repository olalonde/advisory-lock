import test from "tape";

import advisoryLock, { strToKey } from "../";
import { conString, timeout } from "./common";

test("strToKey", (t) => {
  const key = strToKey("test-lock");
  t.deepEqual(
    key,
    [-107789403, -1898803861],
    "generates 2 integer key from string"
  );
  t.end();
});

test("lock/unlock", (t) => {
  t.plan(3);

  const getMutex = advisoryLock(conString);

  const { lock, unlock } = getMutex("test-lock");

  let i = 0;

  const testLockUnlock = async () => {
    try {
      await lock();
      t.equal(i, 0, `${i} is equal to 0`);
      i++;
      await timeout(300);
      i--;
      await unlock();
    } catch (err) {
      t.fail(err);
    }
  };
  testLockUnlock();
  testLockUnlock();
  testLockUnlock();
  // we can acquire lock both times because we're using the same connection
});

test("lock/unlock on different connections", (t) => {
  t.plan(5);

  let i = 0;

  const testLockUnlock = ({ lock, unlock }) =>
    lock()
      .then(() => {
        t.equal(i, 0, "i is equal to 0");
        i++;
        // wait 300ms before decrementing i
        return timeout(300);
      })
      .then(() => i--)
      .then(unlock)
      .catch(t.fail);

  testLockUnlock(advisoryLock(conString)("test-lock"));
  // blocks... because we're using different connections
  // advisoryLock(conString) creates a new connection
  testLockUnlock(advisoryLock(conString)("test-lock"));
  testLockUnlock(advisoryLock(conString)("test-lock"));
  testLockUnlock(advisoryLock(conString)("test-lock"));
  testLockUnlock(advisoryLock(conString)("test-lock"));
});

test("tryLock", async (t) => {
  function assertAcquired(val) {
    t.equal(typeof val, "function", "acquired");
  }
  function assertNotAcquired(val) {
    t.equal(typeof val, "undefined", "not acquired");
  }
  const mutex1 = advisoryLock(conString)("test-try-lock");
  const mutex2 = advisoryLock(conString)("test-try-lock");
  assertAcquired(await mutex1.tryLock());
  assertNotAcquired(await mutex2.tryLock());
  await mutex1.unlock();
  assertAcquired(await mutex2.tryLock());
  assertNotAcquired(await mutex1.tryLock());
  await mutex2.unlock();
});

test("withLock followed by tryLock", async (t) => {
  const mutex1 = advisoryLock(conString)("test-withlock-lock");
  const mutex2 = advisoryLock(conString)("test-withlock-lock");
  const val = await mutex1.withLock(async () => {
    const unlock = await mutex2.tryLock();
    t.equal(typeof unlock, "undefined");
    return "someval";
  });
  t.equal(val, "someval");
  const unlock = await mutex2.tryLock();
  t.equal(typeof unlock, "function");
  await unlock();
});

test("withLock - no promise", (t) => {
  const mutex1 = advisoryLock(conString)("test-withlock-lock");
  mutex1
    .withLock(() => "someval")
    .then((res) => t.equal(res, "someval"))
    .then(() => t.end())
    .catch(t.fail);
});

test("withLock blocks until lock available", (t) => {
  const mutex1 = advisoryLock(conString)("test-withlock-lock");
  const mutex2 = advisoryLock(conString)("test-withlock-lock");
  const logs = [];
  const maybeDone = () => {
    if (logs.length !== 4) return;
    const version1 = [
      "mutex1 enters",
      "mutex1 leaves",
      "mutex2 enters",
      "mutex2 leaves",
    ];
    const version2 = [
      "mutex2 enters",
      "mutex2 leaves",
      "mutex1 enters",
      "mutex1 leaves",
    ];
    if (logs[0] === version1[0]) {
      t.deepEqual(logs, version1);
    } else {
      t.deepEqual(logs, version2);
    }
    t.end();
  };
  mutex1
    .withLock(() => {
      logs.push("mutex1 enters");
      return timeout(300).then(() => logs.push("mutex1 leaves"));
    })
    .then(maybeDone)
    .catch(t.fail);
  mutex2
    .withLock(() => {
      logs.push("mutex2 enters");
      return timeout(300).then(() => logs.push("mutex2 leaves"));
    })
    .then(maybeDone)
    .catch(t.fail);
});

// TODO: test thowing inside critical section unlocks mutex
