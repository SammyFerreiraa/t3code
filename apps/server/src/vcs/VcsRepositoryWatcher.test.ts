// @effect-diagnostics nodeBuiltinImport:off - wraps the node:fs watch the module under test uses.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as VcsProcess from "./VcsProcess.ts";
import * as VcsRepositoryWatcher from "./VcsRepositoryWatcher.ts";

describe("isStatusRelevantChange", () => {
  it("keeps worktree files and status-moving git metadata only", () => {
    const relevant = VcsRepositoryWatcher.isStatusRelevantChange;
    assert.isTrue(relevant("worktree", "index.ts"));
    assert.isFalse(relevant("worktree", ".git"));
    for (const name of ["HEAD", "index", "packed-refs", "MERGE_HEAD", "rebase-merge"]) {
      assert.isTrue(relevant("gitDir", name), name);
    }
    for (const name of ["objects", "logs", "index.lock", "HEAD.lock", "FETCH_HEAD", "config"]) {
      assert.isFalse(relevant("gitDir", name), name);
    }
    assert.isTrue(relevant("commonDir", "packed-refs"));
    assert.isFalse(relevant("commonDir", "HEAD"));
    assert.isTrue(relevant("refs", "main"));
    assert.isFalse(relevant("refs", "main.lock"));
  });
});

describe("worktreeDirectoriesFromFiles", () => {
  it.effect("lists every ancestor directory, or nothing past the limit", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const files = "a/b/c.txt\0d.txt\0a/e.txt\0";
      assert.deepStrictEqual(
        VcsRepositoryWatcher.worktreeDirectoriesFromFiles(path, "/r", files, 3),
        new Set(["/r", "/r/a", "/r/a/b"]),
      );
      assert.isNull(VcsRepositoryWatcher.worktreeDirectoriesFromFiles(path, "/r", files, 2));
    }).pipe(Effect.provide(Path.layer)),
  );
});

describe("makeCoalescedRunner", () => {
  it.effect("runs once for a burst of triggers", () =>
    Effect.gen(function* () {
      const runs = yield* Queue.unbounded<number>();
      const count = yield* Ref.make(0);
      const trigger = yield* VcsRepositoryWatcher.makeCoalescedRunner(
        Ref.updateAndGet(count, (n) => n + 1).pipe(
          Effect.flatMap((n) => Queue.offer(runs, n)),
          Effect.asVoid,
        ),
        Duration.millis(200),
      );

      yield* Effect.sync(trigger);
      yield* Effect.sync(trigger);
      yield* Effect.sync(trigger);
      yield* TestClock.adjust(Duration.millis(199));
      assert.equal(yield* Queue.size(runs), 0);
      yield* TestClock.adjust(Duration.millis(1));
      assert.equal(yield* Queue.take(runs), 1);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.equal(yield* Queue.size(runs), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("queues exactly one more run for triggers that arrive mid-run", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<number>();
      const gate = yield* Deferred.make<void>();
      const count = yield* Ref.make(0);
      const trigger = yield* VcsRepositoryWatcher.makeCoalescedRunner(
        Effect.gen(function* () {
          const n = yield* Ref.updateAndGet(count, (value) => value + 1);
          yield* Queue.offer(started, n);
          if (n === 1) yield* Deferred.await(gate);
        }),
        Duration.millis(200),
      );

      yield* Effect.sync(trigger);
      yield* TestClock.adjust(Duration.millis(200));
      assert.equal(yield* Queue.take(started), 1);
      yield* Effect.sync(trigger);
      yield* Effect.sync(trigger);
      yield* Deferred.succeed(gate, undefined);
      yield* TestClock.adjust(Duration.millis(200));
      assert.equal(yield* Queue.take(started), 2);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.equal(yield* Queue.size(started), 0);
    }).pipe(Effect.scoped),
  );
});

// Tracks open directory watches so tests can see which start and stop.
const layerTestFor = (activeWatches: Set<string>) =>
  VcsRepositoryWatcher.layer.pipe(
    Layer.provide(
      Layer.succeed(VcsRepositoryWatcher.VcsDirectoryWatch, (directory, listener) => {
        const watcher = NodeFS.watch(directory, listener);
        activeWatches.add(directory);
        const close = watcher.close.bind(watcher);
        watcher.close = () => {
          activeWatches.delete(directory);
          close();
        };
        return watcher;
      }),
    ),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    return yield* vcsProcess.run({ operation: "test.git", command: "git", args, cwd });
  });

const makeRepository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-vcs-watch-" }));
  yield* git(cwd, ["init"]);
  yield* git(cwd, ["config", "user.email", "test@test.com"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  yield* fs.makeDirectory(path.join(cwd, "src"));
  yield* fs.writeFileString(path.join(cwd, "src", "a.txt"), "a\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "init"]);
  return cwd;
});

const takeUntil = <A>(queue: Queue.Dequeue<A>, predicate: (value: A) => boolean) =>
  Queue.take(queue).pipe(Effect.repeat({ until: predicate }));

describe("VcsRepositoryWatcher", () => {
  // Live: real git subprocesses and real file system events.
  it.live("reports worktree and ref changes, ignoring objects, and follows new directories", () =>
    Effect.gen(function* () {
      const activeWatches = new Set<string>();
      return yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const watcher = yield* VcsRepositoryWatcher.VcsRepositoryWatcher;
        const cwd = yield* makeRepository;
        const changes = yield* Queue.unbounded<VcsRepositoryWatcher.VcsRepositoryChange>();
        const scope = yield* Scope.make();
        yield* watcher
          .watch(cwd, (change) => Queue.offer(changes, change))
          .pipe(Scope.provide(scope));
        for (const directory of [cwd, path.join(cwd, "src"), path.join(cwd, ".git")]) {
          assert.isTrue(activeWatches.has(directory), directory);
        }
        assert.isTrue(activeWatches.has(path.join(cwd, ".git", "refs", "heads")));
        assert.isFalse([...activeWatches].some((directory) => directory.includes("objects")));

        // Written before the worktree edit: a gitdir event would mark the batch refsChanged.
        yield* fs.makeDirectory(path.join(cwd, ".git", "objects", "zz"));
        yield* fs.writeFileString(path.join(cwd, ".git", "objects", "zz", "object"), "x");
        yield* fs.writeFileString(path.join(cwd, "src", "a.txt"), "edited\n");
        assert.isFalse((yield* Queue.take(changes)).refsChanged);

        yield* git(cwd, ["commit", "-am", "edit"]);
        yield* takeUntil(changes, (change) => change.refsChanged);

        yield* fs.makeDirectory(path.join(cwd, "fresh"));
        yield* fs.writeFileString(path.join(cwd, "fresh", "b.txt"), "b\n");
        // The resync runs before the batch's onChange.
        yield* takeUntil(changes, () => activeWatches.has(path.join(cwd, "fresh")));

        yield* Scope.close(scope, Exit.void);
        assert.equal(activeWatches.size, 0);
      }).pipe(Effect.provide(layerTestFor(activeWatches)));
    }).pipe(Effect.scoped),
  );

  it.live("still watches refs when the file listing fails", () =>
    Effect.gen(function* () {
      const activeWatches = new Set<string>();
      return yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const watcher = yield* VcsRepositoryWatcher.VcsRepositoryWatcher;
        const cwd = yield* makeRepository;
        // ls-files reads the index; rev-parse and symbolic-ref do not.
        yield* fs.writeFileString(path.join(cwd, ".git", "index"), "corrupt");
        const changes = yield* Queue.unbounded<VcsRepositoryWatcher.VcsRepositoryChange>();
        yield* watcher.watch(cwd, (change) => Queue.offer(changes, change));

        assert.isTrue(activeWatches.has(cwd));
        assert.isTrue(activeWatches.has(path.join(cwd, ".git", "refs", "heads")));
        assert.isFalse(activeWatches.has(path.join(cwd, "src")));

        yield* git(cwd, ["symbolic-ref", "HEAD", "refs/heads/other"]);
        assert.isTrue((yield* Queue.take(changes)).refsChanged);
      }).pipe(Effect.provide(layerTestFor(activeWatches)));
    }).pipe(Effect.scoped),
  );

  it.live("shares one set of watchers per repository until the last retainer leaves", () =>
    Effect.gen(function* () {
      const activeWatches = new Set<string>();
      return yield* Effect.gen(function* () {
        const watcher = yield* VcsRepositoryWatcher.VcsRepositoryWatcher;
        const cwd = yield* makeRepository;
        assert.equal(activeWatches.size, 0);

        const first = yield* Scope.make();
        const second = yield* Scope.make();
        yield* watcher.watch(cwd, () => Effect.void).pipe(Scope.provide(first));
        const watched = activeWatches.size;
        yield* watcher.watch(cwd, () => Effect.void).pipe(Scope.provide(second));
        assert.equal(activeWatches.size, watched);

        yield* Scope.close(first, Exit.void);
        assert.equal(activeWatches.size, watched);
        yield* Scope.close(second, Exit.void);
        assert.equal(activeWatches.size, 0);
      }).pipe(Effect.provide(layerTestFor(activeWatches)));
    }).pipe(Effect.scoped),
  );
});
