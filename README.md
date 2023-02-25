# advisory-lock

[![Build
Status](https://github.com/olalonde/advisory-lock/actions/workflows/nodejs.yml/badge.svg)](https://github.com/olalonde/advisory-lock/actions/workflows/nodejs.yml)

Distributed\* locking using [PostgreSQL advisory locks](http://www.postgresql.org/docs/current/static/explicit-locking.html#ADVISORY-LOCKS).

Some use cases:

- You have a [clock process](https://devcenter.heroku.com/articles/scheduled-jobs-custom-clock-processes)
  and want to make absolutely sure there will never be more than one
  process active at any given time.

  This sort of situation can otherwise arise if the clock process is
  scaled up by accident or during a deployment which keeps the old
  version running until the new version responds to a health check.

- Running a database migration at server startup. If your app is scaled,
  multiple processes will simultaneously try to run the database
  migration which can lead to problems.

- Leader election. Let's say you have a web app and want to post a
  message to Slack every 30 mins containing some statistic (e.g. new
  registrations in the last 30 mins). You might have 10 processes
  running but don't want to get 10 identical messages in Slack.
  You can use this library to elect a "master" process which
  is responsible for sending the message.

- [etc.](https://www.google.com/?q=distributed+lock#newwindow=1&q=distributed+lock)

\* Your PostgreSQL database being a central point of failure. For
a high available distributed lock, have a look at
[ZooKeeper](https://zookeeper.apache.org).

## Install

```console
npm install --save advisory-lock
```

## Example

```javascript
import advisoryLock from "advisory-lock";
const mutex = advisoryLock("postgres://user:pass@localhost:3475/dbname")(
  "some-lock-name"
);

// waits and blocks indefinitely for the lock before executing the function
await mutex.withLock(async () => {
  // do something exclusive
  // releases lock when promise resolves or rejects
});

// doesn't "block", just tells us if the lock is available
const unlock = await mutex.tryLock();
if (unlock) {
  // we are now responsible for manually releasing the lock
  // do something...
  await unlock();
} else {
  throw new Error("could not acquire lock");
}
```

See [./test](./test) for more usage examples.

## CLI Usage

A `withlock` command line utility is provided to make to facilitate the
common use case of ensuring only one instance of a process is running at any
time.

![withlock demo](./withlock-demo.gif)

```bash
withlock <lockName> [--db <connectionString>] -- <command>
```

Where `<lockName>` is the name of the lock, `<command>` (everything after
`--`) is the command to run exclusively, once the lock is acquired.
`--db <connectionString>` is optional and if not specified, the
`PG_CONNECTION_STRING` environment variable will be used.

Example:

```bash
export PG_CONNECTION_STRING="postgres://postgres@127.0.0.1/mydb"
withlock dbmigration -- npm run knex migrate:latest
```

## Usage

### advisoryLock(connectionString)

- `connectionString` must be a Postgres connection string

Returns a `createMutex` function.

### createMutex(lockName)

- `lockName` must be a unique identifier for the lock

Returns a **mutex** object containing the functions listed below. All
**object** methods are really just functions attached to the object and
are not bound to _this_ so they can be safely destructured,
e.g. `const { withLock } = createMutext(lockName)`.

For a better understanding of what each functions does,
see [PosgtreSQL's manual](http://www.postgresql.org/docs/current/static/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS).

#### mutex.withLock(fn)

- `fn` Function to be executed once the lock is acquired.

Like `lock()` but automatically release the lock after `fn()` is executed.

Returns the value returned by `fn()`.

#### mutex.tryLock(): UnlockFunction

Returns an `unlock()` function if the lock was acquired and `undefined` otherwise.

#### mutex.lock(): UnlockFunction

Blocks and waits for lock acquisition and returns an `unlock()` function.
