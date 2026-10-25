// @effect-diagnostics nodeBuiltinImport:off - Effect's FileSystem.watch installs each watch on a forked fiber; node:fs installs synchronously, so a returned watch is live.
import * as NodeFS from "node:fs";

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as RcMap from "effect/RcMap";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as VcsProcess from "./VcsProcess.ts";

const VCS_REPOSITORY_CHANGE_DELAY = Duration.millis(200);
const MAX_LIST_FILES_OUTPUT_BYTES = 64 * 1024 * 1024;
// Past this, per-directory watches would eat the user's inotify budget that editors and
// other watchers share; only refs and the top level are watched.
const MAX_WORKTREE_DIRECTORIES = 10_000;

// Entries directly inside the gitdir that can move the status. objects/, logs/,
// *.lock and FETCH_HEAD cannot (a fetch that moves a branch also writes refs/remotes).
const GIT_DIR_STATUS_ENTRIES = new Set([
  "HEAD",
  "index",
  "packed-refs",
  "MERGE_HEAD",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
]);

type WatchedDirectoryKind = "worktree" | "gitDir" | "commonDir" | "refs";

/** @internal Exported for tests. */
export function isStatusRelevantChange(kind: WatchedDirectoryKind, name: string): boolean {
  switch (kind) {
    case "worktree":
      return name !== ".git";
    case "gitDir":
      return GIT_DIR_STATUS_ENTRIES.has(name);
    case "commonDir":
      return name === "packed-refs";
    case "refs":
      return !name.endsWith(".lock");
  }
}

/**
 * The top level plus every directory holding a listed file, or null past `maxDirectories`.
 * @internal Exported for tests.
 */
export function worktreeDirectoriesFromFiles(
  path: Path.Path,
  topLevel: string,
  nulSeparatedFiles: string,
  maxDirectories: number,
): Set<string> | null {
  const directories = new Set([topLevel]);
  for (const file of nulSeparatedFiles.split("\0")) {
    let directory = path.dirname(file);
    while (directory !== "." && directory !== "") {
      const absolute = path.join(topLevel, directory);
      if (directories.has(absolute)) break;
      directories.add(absolute);
      if (directories.size > maxDirectories) return null;
      directory = path.dirname(directory);
    }
  }
  return directories;
}

export interface VcsRepositoryChange {
  /** HEAD, a branch, or a remote-tracking ref may have moved, so ahead/behind can change too. */
  readonly refsChanged: boolean;
}

export interface VcsRepositoryWatcherShape {
  /**
   * Calls `onChange` shortly after the repository containing `cwd` changes, for as long
   * as the scope is open. Watchers are shared per cwd; the first retainer's `onChange`
   * serves every retainer of that cwd.
   */
  readonly watch: (
    cwd: string,
    onChange: (change: VcsRepositoryChange) => Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

export class VcsRepositoryWatcher extends Context.Reference<VcsRepositoryWatcherShape>(
  "t3/vcs/VcsRepositoryWatcher",
  { defaultValue: () => ({ watch: () => Effect.void }) },
) {}

/** Non-recursive watch of one directory. A reference so tests can count open watches. */
export class VcsDirectoryWatch extends Context.Reference<
  (directory: string, listener: NodeFS.WatchListener<string>) => NodeFS.FSWatcher
>("t3/vcs/VcsDirectoryWatch", {
  defaultValue: () => (directory, listener) => NodeFS.watch(directory, listener),
}) {}

/**
 * Runs `run` `delay` after a trigger. Triggers during the delay coalesce, and triggers
 * while `run` is in flight schedule exactly one more run. The trigger is synchronous so
 * file system callbacks can call it.
 */
export const makeCoalescedRunner = Effect.fn("VcsRepositoryWatcher.makeCoalescedRunner")(function* <
  R,
>(run: Effect.Effect<void, never, R>, delay: Duration.Duration) {
  const signal = yield* Queue.sliding<void>(1);
  yield* Queue.take(signal).pipe(
    Effect.andThen(Effect.sleep(delay)),
    Effect.andThen(Queue.clear(signal)),
    Effect.andThen(run),
    Effect.forever,
    Effect.forkScoped,
  );
  return (): void => {
    Queue.offerUnsafe(signal, undefined);
  };
});

interface PendingChange {
  changed: boolean;
  // Renamed entries that are not watched directories: maybe a new directory to watch.
  readonly renamed: Set<string>;
  refsChanged: boolean;
  resync: boolean;
}

const emptyPending = (): PendingChange => ({
  changed: false,
  renamed: new Set(),
  refsChanged: false,
  resync: false,
});

// Equal by cwd only, so the RcMap shares one session per cwd and the first retainer's
// onChange serves it.
class SessionKey implements Equal.Equal {
  readonly cwd: string;
  readonly onChange: (change: VcsRepositoryChange) => Effect.Effect<void>;
  constructor(cwd: string, onChange: (change: VcsRepositoryChange) => Effect.Effect<void>) {
    this.cwd = cwd;
    this.onChange = onChange;
  }
  [Equal.symbol](that: unknown): boolean {
    return that instanceof SessionKey && that.cwd === this.cwd;
  }
  [Hash.symbol](): number {
    return Hash.string(this.cwd);
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const watchDirectory = yield* VcsDirectoryWatch;

  const git = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    vcsProcess
      .run({ operation, command: "git", args, cwd, maxOutputBytes: MAX_LIST_FILES_OUTPUT_BYTES })
      .pipe(Effect.map((output) => output.stdout));

  // One inotify watch per directory, and only for directories that hold tracked or
  // untracked-but-not-ignored files. Node's recursive fs.watch on Linux also walks
  // node_modules and ignored output: on this repository, 12 s and 257k watches.
  // A session lives as long as its subscribers; keep its loop out of a parent span.
  const startSession = Effect.fnUntraced(function* (
    cwd: string,
    onChange: (change: VcsRepositoryChange) => Effect.Effect<void>,
  ) {
    const resolved = yield* git(cwd, "VcsRepositoryWatcher.resolveRepository", [
      "rev-parse",
      "--show-toplevel",
      "--absolute-git-dir",
      "--git-common-dir",
    ]).pipe(Effect.option);
    if (resolved._tag === "None") return;
    const [topLevel, gitDir, rawCommonDir] = resolved.value.trim().split("\n");
    if (!topLevel || !gitDir || !rawCommonDir) return;
    const commonDir = path.resolve(cwd, rawCommonDir);

    const watched = new Map<string, NodeFS.FSWatcher>();
    let pending = emptyPending();
    let trigger = (): void => {};
    const loggedWarnings = new Set<string>();
    const warnOnce = (message: string, fields: Record<string, unknown> = {}) =>
      Effect.suspend(() => {
        if (loggedWarnings.has(message)) return Effect.void;
        loggedWarnings.add(message);
        return Effect.logWarning(message, { cwdLength: cwd.length, ...fields });
      });
    const syncLock = yield* Semaphore.make(1);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const watcher of watched.values()) watcher.close();
        watched.clear();
      }),
    );

    const listDirectories = Effect.gen(function* () {
      const files = yield* git(topLevel, "VcsRepositoryWatcher.listFiles", [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ]).pipe(
        Effect.tapError((cause) =>
          warnOnce("VCS repository watcher could not list files; watching refs only", { cause }),
        ),
        Effect.option,
      );
      const worktreeDirectories =
        files._tag === "Some"
          ? worktreeDirectoriesFromFiles(path, topLevel, files.value, MAX_WORKTREE_DIRECTORIES)
          : null;
      if (files._tag === "Some" && worktreeDirectories === null) {
        yield* warnOnce("VCS repository watcher found too many directories; watching refs only", {
          maxDirectories: MAX_WORKTREE_DIRECTORIES,
        });
      }
      const directories = new Map<string, WatchedDirectoryKind>(
        [...(worktreeDirectories ?? [topLevel])].map((directory) => [directory, "worktree"]),
      );
      directories.set(gitDir, "gitDir");
      if (commonDir !== gitDir) directories.set(commonDir, "commonDir");
      for (const refsRoot of ["refs/heads", "refs/remotes"]) {
        const root = path.join(commonDir, refsRoot);
        directories.set(root, "refs");
        const entries = yield* fs
          .readDirectory(root, { recursive: true })
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        for (const entry of entries) {
          const absolute = path.join(root, entry);
          const info = yield* fs.stat(absolute).pipe(Effect.option);
          if (info._tag === "Some" && info.value.type === "Directory") {
            directories.set(absolute, "refs");
          }
        }
      }
      return directories;
    });

    const onEvent = (
      directory: string,
      kind: WatchedDirectoryKind,
      eventType: NodeFS.WatchEventType,
      filename: string | null,
    ) => {
      if (filename === null || !isStatusRelevantChange(kind, path.basename(filename))) return;
      const absolute = path.join(directory, filename);
      pending.changed = true;
      if (kind !== "worktree" && path.basename(filename) !== "index") pending.refsChanged = true;
      if (eventType === "rename" && kind !== "gitDir") {
        if (watched.has(absolute)) pending.resync = true;
        else pending.renamed.add(absolute);
      }
      trigger();
    };

    const openWatch = Effect.fnUntraced(function* (directory: string, kind: WatchedDirectoryKind) {
      const watcher = yield* Effect.try(() =>
        watchDirectory(directory, (eventType, filename) =>
          onEvent(directory, kind, eventType, filename),
        ),
      ).pipe(
        // A directory removed since listing, or an exhausted inotify limit (ENOSPC). The
        // rest keep working, and focus/turn-end refreshes still cover the gap.
        Effect.tapError((cause) =>
          warnOnce("VCS repository watcher could not watch a directory", { cause }),
        ),
        Effect.option,
      );
      if (watcher._tag === "None") return;
      // Without a listener, an "error" event (the directory was deleted) would crash the process.
      watcher.value.on("error", () => {
        watcher.value.close();
        if (watched.get(directory) === watcher.value) watched.delete(directory);
      });
      watched.set(directory, watcher.value);
    });

    const syncDirectories = syncLock.withPermits(1)(
      Effect.gen(function* () {
        const desired = yield* listDirectories;
        for (const [directory, watcher] of watched) {
          if (desired.has(directory)) continue;
          watcher.close();
          watched.delete(directory);
        }
        for (const [directory, kind] of desired) {
          if (!watched.has(directory)) yield* openWatch(directory, kind);
        }
      }),
    );

    trigger = yield* makeCoalescedRunner(
      Effect.gen(function* () {
        const batch = pending;
        pending = emptyPending();
        if (!batch.changed) return;
        let resync = batch.resync;
        for (const renamed of batch.renamed) {
          if (resync) break;
          const info = yield* fs.stat(renamed).pipe(Effect.option);
          resync = info._tag === "Some" && info.value.type === "Directory";
        }
        if (resync) yield* syncDirectories;
        yield* onChange({ refsChanged: batch.refsChanged });
      }),
      VCS_REPOSITORY_CHANGE_DELAY,
    );

    yield* syncDirectories;
  });

  const sessions = yield* RcMap.make({
    lookup: (key: SessionKey) => startSession(key.cwd, key.onChange),
  });

  const watch: VcsRepositoryWatcherShape["watch"] = Effect.fn("VcsRepositoryWatcher.watch")(
    function* (cwd, onChange) {
      yield* RcMap.get(sessions, new SessionKey(cwd, onChange));
    },
  );

  return { watch } satisfies VcsRepositoryWatcherShape;
});

export const layer = Layer.effect(VcsRepositoryWatcher, make);
