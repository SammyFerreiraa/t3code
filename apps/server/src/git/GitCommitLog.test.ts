import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitCommitLog from "./GitCommitLog.ts";

const layer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-commit-log-" })),
  Layer.provideMerge(NodeServices.layer),
);

const setupRepo = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-commit-log-" });
  const git = (...args: string[]) =>
    driver
      .execute({ operation: "test.git", cwd, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  const commit = (file: string, message: string) =>
    fileSystem
      .writeFileString(path.join(cwd, file), `${message}\n`)
      .pipe(
        Effect.andThen(git("add", "-A")),
        Effect.andThen(git("commit", "-m", message)),
        Effect.andThen(git("rev-parse", "HEAD")),
      );
  yield* git("init", "-b", "main");
  yield* git("config", "user.email", "t@t");
  yield* git("config", "user.name", "Ada Lovelace");
  return { cwd, driver, git, commit, fileSystem, path };
});

it.layer(layer)("GitCommitLog", (it) => {
  it.effect("a repository without commits has an empty history", () =>
    Effect.gen(function* () {
      const { cwd, driver } = yield* setupRepo;
      const log = yield* GitCommitLog.readLog(driver, { cwd });
      assert.deepStrictEqual(log, { commits: [], nextCursor: null });
    }),
  );

  it.effect("pages newest first by cursor", () =>
    Effect.gen(function* () {
      const { cwd, driver, commit } = yield* setupRepo;
      for (const n of [1, 2, 3, 4, 5]) yield* commit(`f${n}.txt`, `commit ${n}`);

      const first = yield* GitCommitLog.readLog(driver, { cwd, limit: 2 });
      assert.deepStrictEqual(
        first.commits.map((c) => c.subject),
        ["commit 5", "commit 4"],
      );
      assert.strictEqual(first.nextCursor, 2);
      const second = yield* GitCommitLog.readLog(driver, {
        cwd,
        limit: 2,
        cursor: first.nextCursor!,
      });
      assert.deepStrictEqual(
        second.commits.map((c) => c.subject),
        ["commit 3", "commit 2"],
      );
      const last = yield* GitCommitLog.readLog(driver, {
        cwd,
        limit: 2,
        cursor: second.nextCursor!,
      });
      assert.deepStrictEqual(
        last.commits.map((c) => c.subject),
        ["commit 1"],
      );
      assert.strictEqual(last.nextCursor, null);
    }),
  );

  it.effect("keeps subjects with separators, quotes and unicode intact", () =>
    Effect.gen(function* () {
      const { cwd, driver, git, commit } = yield* setupRepo;
      const subject = `fix: "quoted" \\ back | pipe, \x1f unit, 日本語 🎉 -- --help`;
      const sha = yield* commit("a.txt", "seed");
      yield* git("commit", "--allow-empty", "-m", subject, "-m", "body line\n\nsecond paragraph");

      const [head, seed] = (yield* GitCommitLog.readLog(driver, { cwd })).commits;
      assert.strictEqual(head?.subject, subject);
      assert.strictEqual(head?.authorName, "Ada Lovelace");
      assert.strictEqual(head?.sha.length, 40);
      assert.isTrue(head?.sha.startsWith(head.shortSha));
      assert.match(head?.authoredAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
      assert.strictEqual(seed?.sha, sha);
    }),
  );

  it.effect("labels the checked-out branch, other branches, remotes and tags", () =>
    Effect.gen(function* () {
      const { cwd, driver, git, commit } = yield* setupRepo;
      yield* commit("a.txt", "one");
      yield* git("branch", "side");
      yield* git("tag", "v1");
      yield* git("update-ref", "refs/remotes/origin/main", "HEAD");
      yield* git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

      const [head] = (yield* GitCommitLog.readLog(driver, { cwd })).commits;
      const byName = Object.fromEntries((head?.refs ?? []).map((ref) => [ref.name, ref.kind]));
      assert.deepStrictEqual(byName, {
        main: "head",
        side: "branch",
        v1: "tag",
        "origin/main": "remote",
      });

      yield* git("checkout", "--detach");
      const [detached] = (yield* GitCommitLog.readLog(driver, { cwd })).commits;
      assert.deepStrictEqual(detached?.refs.map((ref) => `${ref.kind}:${ref.name}`).toSorted(), [
        "branch:main",
        "branch:side",
        "head:HEAD",
        "remote:origin/main",
        "tag:v1",
      ]);
    }),
  );

  it.effect("lists the files of a root commit", () =>
    Effect.gen(function* () {
      const { cwd, driver, commit } = yield* setupRepo;
      const sha = yield* commit("first.txt", "root");

      const result = yield* GitCommitLog.readCommitFiles(driver, { cwd, sha });
      assert.deepStrictEqual(result, {
        files: [{ path: "first.txt", previousPath: null, status: "added" }],
        truncated: false,
      });
    }),
  );

  it.effect("reports modified, deleted and renamed files, including odd names", () =>
    Effect.gen(function* () {
      const { cwd, driver, git, commit, fileSystem, path } = yield* setupRepo;
      yield* fileSystem.writeFileString(path.join(cwd, "keep.txt"), "keep\n".repeat(20));
      yield* fileSystem.writeFileString(path.join(cwd, "gone.txt"), "gone\n");
      yield* fileSystem.writeFileString(path.join(cwd, "old name.txt"), "rename me\n".repeat(20));
      yield* commit("seed.txt", "seed");
      yield* fileSystem.writeFileString(path.join(cwd, "keep.txt"), "changed\n");
      yield* git("rm", "-q", "gone.txt");
      yield* git("mv", "old name.txt", "új név.txt");
      const sha = yield* commit("keep.txt", "edit");

      const { files } = yield* GitCommitLog.readCommitFiles(driver, { cwd, sha });
      assert.deepStrictEqual(
        files.toSorted((a, b) => a.path.localeCompare(b.path)),
        [
          { path: "gone.txt", previousPath: null, status: "deleted" },
          { path: "keep.txt", previousPath: null, status: "modified" },
          { path: "új név.txt", previousPath: "old name.txt", status: "renamed" },
        ],
      );
    }),
  );

  it.effect("compares a merge with its first parent only", () =>
    Effect.gen(function* () {
      const { cwd, driver, git, commit } = yield* setupRepo;
      yield* commit("base.txt", "base");
      yield* git("switch", "-c", "feature");
      yield* commit("feature.txt", "feature");
      yield* git("switch", "main");
      yield* commit("main.txt", "main work");
      yield* git("merge", "--no-ff", "feature", "-m", "merge feature");
      const sha = yield* git("rev-parse", "HEAD");

      const { files } = yield* GitCommitLog.readCommitFiles(driver, { cwd, sha });
      assert.deepStrictEqual(files, [{ path: "feature.txt", previousPath: null, status: "added" }]);
    }),
  );

  it.effect("cuts a commit with more output than the limit instead of failing", () =>
    Effect.gen(function* () {
      const { cwd, driver, commit, fileSystem, path } = yield* setupRepo;
      for (let n = 0; n < 40; n++) {
        yield* fileSystem.writeFileString(path.join(cwd, `a-long-file-name-${n}.txt`), "x\n");
      }
      const sha = yield* commit("last.txt", "many files");

      const result = yield* GitCommitLog.readCommitFiles(driver, { cwd, sha }, 200);
      assert.isTrue(result.truncated);
      assert.isAbove(result.files.length, 0);
      assert.isBelow(result.files.length, 41);
      // The record the cut landed in is dropped, so every path is a whole one.
      for (const file of result.files) {
        assert.match(file.path, /^(a-long-file-name-\d+|last)\.txt$/);
      }
    }),
  );

  it.effect("reads the path of an unknown status code as its own", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(GitCommitLog.parseNameStatus("X\0Makefile\0M\0real.txt\0", false), [
        { path: "real.txt", previousPath: null, status: "modified" },
      ]);
    }),
  );

  it.effect("refuses anything that is not a hex commit hash", () =>
    Effect.gen(function* () {
      const { cwd, driver, commit } = yield* setupRepo;
      yield* commit("a.txt", "one");
      for (const sha of ["--output=/tmp/pwned", "HEAD", "main", "abc", "zzzzzzzz", "HEAD~1"]) {
        const error = yield* GitCommitLog.readCommitFiles(driver, { cwd, sha }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "GitCommandError");
      }
      const missing = yield* GitCommitLog.readCommitFiles(driver, {
        cwd,
        sha: "0123456789abcdef0123456789abcdef01234567",
      }).pipe(Effect.flip);
      assert.strictEqual(missing._tag, "GitCommandError");
    }),
  );
});
