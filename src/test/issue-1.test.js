import test from "tape";
import pg from "pg";
import advisoryLock from "../";
import { conString, timeout } from "./common";

// Returns the number of active connections to the database
async function getActiveConnections() {
  const client = new pg.Client(conString);
  try {
    await client.connect();
    const sql = "SELECT count(*) FROM pg_stat_activity";
    const result = await client.query(sql);
    return Number(result.rows[0].count);
  } finally {
    client.end();
  }
}

test("withLock releases connection after unlocking", async (t) => {
  const startConnectionCount = await getActiveConnections();
  for (let i = 0; i < 25; i++) {
    const createMutex = advisoryLock(conString);
    await createMutex("test-withlock-release").withLock(() => {
      // do something
    });
  }
  await timeout(1000);
  const connectionCount = await getActiveConnections();
  t.equal(connectionCount, startConnectionCount);
});
