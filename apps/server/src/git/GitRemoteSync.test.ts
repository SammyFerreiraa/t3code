import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitRemoteSync from "./GitRemoteSync.ts";

const layer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-remote-sync-" })),
  Layer.provideMerge(NodeServices.layer),
);

// `local` is the user's checkout; `other` is a second clone standing in for a collaborator.
const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-remote-sync-" });
  const remote = path.join(root, "remote.git");
  const local = path.join(root, "local");
  const other = path.join(root, "other");
  const run = (cwd: string, ...args: string[]) =>
    driver
      .execute({ operation: "test.git", cwd, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  const write = (cwd: string, file: string, contents: string) =>
    fileSystem.writeFileString(path.join(cwd, file), contents);
  const commit = (cwd: string, file: string, contents: string, message: string) =>
    write(cwd, file, contents).pipe(
      Effect.andThen(run(cwd, "add", file)),
      Effect.andThen(run(cwd, "commit", "-m", message)),
    );
  const identify = (cwd: string) =>
    run(cwd, "config", "user.email", "t@t").pipe(
      Effect.andThen(run(cwd, "config", "user.name", "t")),
    );

  yield* fileSystem.makeDirectory(local);
  yield* run(root, "init", "--bare", "-b", "main", remote);
  yield* run(local, "init", "-b", "main");
  yield* identify(local);
  yield* commit(local, "README.md", "base\n", "init");
  yield* run(local, "remote", "add", "origin", remote);
  yield* run(local, "push", "-u", "origin", "main");
  yield* run(root, "clone", remote, other);
  yield* identify(other);

  const publishFeature = Effect.gen(function* () {
    yield* run(local, "switch", "-c", "feature");
    yield* commit(local, "feature.txt", "feature\n", "feature");
    yield* run(local, "push", "-u", "origin", "feature");
    yield* run(other, "fetch", "origin");
    yield* run(other, "switch", "feature");
  });
  const remoteHead = (branch: string) =>
    run(local, "ls-remote", "origin", `refs/heads/${branch}`).pipe(
      Effect.map((line) => line.split("\t")[0]),
    );
  return { driver, local, other, run, write, commit, publishFeature, remoteHead };
});

it.layer(layer)("GitRemoteSync", (it) => {
  it.effect("fetch prunes remote branches that were deleted", () =>
    Effect.gen(function* () {
      const { driver, local, other, run, commit } = yield* setup;
      yield* run(other, "switch", "-c", "gone");
      yield* commit(other, "gone.txt", "gone\n", "gone");
      yield* run(other, "push", "-u", "origin", "gone");
      yield* run(local, "fetch", "origin");
      yield* run(other, "push", "origin", "--delete", "gone");

      yield* GitRemoteSync.fetchBranchRemote(driver, local);

      const refs = yield* run(local, "for-each-ref", "--format=%(refname)", "refs/remotes/origin");
      assert.notInclude(refs, "refs/remotes/origin/gone");
      assert.include(refs, "refs/remotes/origin/main");
    }),
  );

  it.effect("force push with lease replaces rewritten history", () =>
    Effect.gen(function* () {
      const { driver, local, run, publishFeature, remoteHead } = yield* setup;
      yield* publishFeature;
      yield* run(local, "commit", "--amend", "-m", "feature, reworded");

      const result = yield* GitRemoteSync.forcePushWithLease(driver, local);

      assert.deepStrictEqual(result, {
        status: "pushed",
        branch: "feature",
        upstreamBranch: "origin/feature",
        setUpstream: false,
      });
      assert.strictEqual(yield* remoteHead("feature"), yield* run(local, "rev-parse", "HEAD"));
    }),
  );

  // The status poll fetches in the background, so the unfetched case is the rare one.
  it.effect.each(["unfetched", "fetched"])(
    "force push keeps commits it has not pulled (%s)",
    (state) =>
      Effect.gen(function* () {
        const { driver, local, other, run, commit, publishFeature, remoteHead } = yield* setup;
        yield* publishFeature;
        yield* commit(other, "theirs.txt", "theirs\n", "theirs");
        yield* run(other, "push");
        const theirs = yield* run(other, "rev-parse", "HEAD");
        if (state === "fetched") yield* run(local, "fetch", "origin");
        yield* run(local, "commit", "--amend", "-m", "feature, reworded");

        const error = yield* Effect.flip(GitRemoteSync.forcePushWithLease(driver, local));

        assert.include(error.detail, "commits you have not pulled");
        assert.strictEqual(yield* remoteHead("feature"), theirs);
      }),
  );

  it.effect("force push refuses the default branch and any upstream with another name", () =>
    Effect.gen(function* () {
      const { driver, local, run } = yield* setup;
      const onDefault = yield* Effect.flip(GitRemoteSync.forcePushWithLease(driver, local));
      assert.include(onDefault.detail, "blocked on the default branch");

      yield* run(local, "switch", "-c", "topic", "--track", "origin/main");
      const onBase = yield* Effect.flip(GitRemoteSync.forcePushWithLease(driver, local));
      assert.include(onBase.detail, "tracks origin/main");

      // Named like the remote-tracking ref, but it is not the default branch by name.
      yield* run(local, "switch", "-c", "origin/main", "--track", "origin/main");
      const aliased = yield* Effect.flip(GitRemoteSync.forcePushWithLease(driver, local));
      assert.include(aliased.detail, "tracks origin/main");
    }),
  );

  it.effect("pull fast-forwards and explains a diverged branch", () =>
    Effect.gen(function* () {
      const { driver, local, other, run, commit } = yield* setup;
      yield* commit(other, "theirs.txt", "theirs\n", "theirs");
      yield* run(other, "push");

      const pulled = yield* driver.pullCurrentBranch(local);
      assert.strictEqual(pulled.status, "pulled");
      assert.strictEqual(
        yield* run(local, "rev-parse", "HEAD"),
        yield* run(other, "rev-parse", "HEAD"),
      );

      yield* commit(other, "theirs-2.txt", "theirs\n", "theirs 2");
      yield* run(other, "push");
      yield* commit(local, "mine.txt", "mine\n", "mine");
      const error = yield* Effect.flip(driver.pullCurrentBranch(local));
      assert.include(error.detail, "diverged. Rebase or merge first.");
    }),
  );

  it.effect("rebases onto the freshly fetched default branch", () =>
    Effect.gen(function* () {
      const { driver, local, other, run, commit, publishFeature } = yield* setup;
      yield* publishFeature;
      yield* run(other, "switch", "main");
      yield* commit(other, "main.txt", "main\n", "main moved");
      yield* run(other, "push");
      const mainHead = yield* run(other, "rev-parse", "HEAD");

      const result = yield* GitRemoteSync.rebaseOntoDefault(driver, local);

      assert.deepStrictEqual(result, { status: "rebased", baseRef: "origin/main" });
      assert.strictEqual(yield* run(local, "rev-parse", "HEAD~1"), mainHead);
      assert.strictEqual(
        yield* GitRemoteSync.rebaseOntoDefault(driver, local).pipe(Effect.map((r) => r.status)),
        "skipped_up_to_date",
      );
    }),
  );

  it.effect("aborts a conflicting rebase and leaves the branch untouched", () =>
    Effect.gen(function* () {
      const { driver, local, other, run, commit, publishFeature } = yield* setup;
      yield* publishFeature;
      yield* commit(local, "README.md", "mine\n", "mine");
      yield* run(other, "switch", "main");
      yield* commit(other, "README.md", "theirs\n", "theirs");
      yield* run(other, "push");
      const before = yield* run(local, "rev-parse", "HEAD");

      const error = yield* Effect.flip(GitRemoteSync.rebaseOntoDefault(driver, local));

      assert.include(error.detail, "aborted");
      assert.strictEqual(yield* run(local, "rev-parse", "HEAD"), before);
      assert.strictEqual(yield* run(local, "symbolic-ref", "--short", "HEAD"), "feature");
      assert.strictEqual(yield* run(local, "status", "--porcelain"), "");
    }),
  );

  it.effect("refuses to rebase a dirty tree or the default branch", () =>
    Effect.gen(function* () {
      const { driver, local, run, write, publishFeature } = yield* setup;
      const onDefault = yield* Effect.flip(GitRemoteSync.rebaseOntoDefault(driver, local));
      assert.include(onDefault.detail, "already the default branch");

      yield* publishFeature;
      yield* write(local, "README.md", "dirty\n");
      const before = yield* run(local, "rev-parse", "HEAD");
      const dirty = yield* Effect.flip(GitRemoteSync.rebaseOntoDefault(driver, local));
      assert.include(dirty.detail, "Commit or stash");
      assert.strictEqual(yield* run(local, "rev-parse", "HEAD"), before);
    }),
  );
});
