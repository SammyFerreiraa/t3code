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

// Counts open directory watches so tests can see them start and stop.
const layerTestFor = (activeWatches: { count: number }) =>
  VcsRepositoryWatcher.layer.pipe(
    Layer.provide(
      Layer.succeed(VcsRepositoryWatcher.VcsDirectoryWatch, (directory, listener) => {
        const watcher = NodeFS.watch(directory, listener);
        activeWatches.count += 1;
        const close = watcher.close.bind(watcher);
        watcher.close = () => {
          activeWatches.count -= 1;
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
      const activeWatches = { count: 0 };
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
        assert.isAbove(activeWatches.count, 0);

        // Written before the worktree edit, so it would land in the same or an earlier batch.
        yield* fs.makeDirectory(path.join(cwd, ".git", "objects", "zz"));
        yield* fs.writeFileString(path.join(cwd, ".git", "objects", "zz", "object"), "x");
        yield* fs.writeFileString(path.join(cwd, "src", "a.txt"), "edited\n");
        const edit = yield* Queue.take(changes);
        assert.include(edit.paths, path.join(cwd, "src", "a.txt"));
        assert.isFalse(edit.paths.some((changed) => changed.includes(`${path.sep}objects`)));
        assert.isFalse(edit.refsChanged);

        yield* git(cwd, ["commit", "-am", "edit"]);
        yield* takeUntil(changes, (change) => change.refsChanged);

        yield* fs.makeDirectory(path.join(cwd, "fresh"));
        yield* fs.writeFileString(path.join(cwd, "fresh", "b.txt"), "b\n");
        yield* takeUntil(changes, (change) => change.paths.includes(path.join(cwd, "fresh")));
        yield* fs.writeFileString(path.join(cwd, "fresh", "b.txt"), "changed\n");
        yield* takeUntil(changes, (change) =>
          change.paths.includes(path.join(cwd, "fresh", "b.txt")),
        );

        yield* Scope.close(scope, Exit.void);
        assert.equal(activeWatches.count, 0);
      }).pipe(Effect.provide(layerTestFor(activeWatches)));
    }).pipe(Effect.scoped),
  );

  it.live("shares one set of watchers per repository until the last retainer leaves", () =>
    Effect.gen(function* () {
      const activeWatches = { count: 0 };
      return yield* Effect.gen(function* () {
        const watcher = yield* VcsRepositoryWatcher.VcsRepositoryWatcher;
        const cwd = yield* makeRepository;
        assert.equal(activeWatches.count, 0);

        const first = yield* Scope.make();
        const second = yield* Scope.make();
        yield* watcher.watch(cwd, () => Effect.void).pipe(Scope.provide(first));
        const watched = activeWatches.count;
        yield* watcher.watch(cwd, () => Effect.void).pipe(Scope.provide(second));
        assert.equal(activeWatches.count, watched);

        yield* Scope.close(first, Exit.void);
        assert.equal(activeWatches.count, watched);
        yield* Scope.close(second, Exit.void);
        assert.equal(activeWatches.count, 0);
      }).pipe(Effect.provide(layerTestFor(activeWatches)));
    }).pipe(Effect.scoped),
  );
});
