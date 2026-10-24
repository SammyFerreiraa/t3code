import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitIndexStaging from "./GitIndexStaging.ts";

const layer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-index-staging-" })),
  Layer.provideMerge(NodeServices.layer),
);

const setupRepo = (options: { readonly commit: boolean }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-index-staging-" });
    const git = (...args: string[]) =>
      driver
        .execute({ operation: "test.git", cwd, args })
        .pipe(Effect.map((result) => result.stdout));
    const write = (file: string, contents: string) =>
      fileSystem.writeFileString(path.join(cwd, file), contents);
    yield* git("init", "-b", "main");
    yield* git("config", "user.email", "t@t");
    yield* git("config", "user.name", "t");
    if (options.commit) {
      yield* write("tracked.txt", "one\n");
      yield* git("add", ".");
      yield* git("commit", "-m", "init");
    }
    const files = () =>
      driver
        .statusDetailsLocal(cwd)
        .pipe(
          Effect.map((status) =>
            status.workingTree.files.map(
              (file) =>
                `${file.path}:${file.staged ? "S" : ""}${file.unstaged ? "U" : ""}${file.untracked ? "?" : ""}`,
            ),
          ),
        );
    return { cwd, driver, git, write, files };
  });

it.layer(layer)("GitIndexStaging", (it) => {
  it.effect("stages and unstages chosen paths, keeping the worktree", () =>
    Effect.gen(function* () {
      const { cwd, driver, git, write, files } = yield* setupRepo({ commit: true });
      yield* write("tracked.txt", "one\ntwo\n");
      yield* write("new file.txt", "new\n");

      yield* GitIndexStaging.stagePaths(driver, { cwd, paths: ["tracked.txt", "new file.txt"] });
      assert.deepStrictEqual(yield* files(), ["new file.txt:S", "tracked.txt:S"]);

      yield* write("tracked.txt", "one\ntwo\nthree\n");
      yield* GitIndexStaging.unstagePaths(driver, { cwd, paths: ["new file.txt"] });
      assert.deepStrictEqual(yield* files(), ["new file.txt:?", "tracked.txt:SU"]);

      yield* GitIndexStaging.unstagePaths(driver, { cwd });
      assert.deepStrictEqual(yield* files(), ["new file.txt:?", "tracked.txt:U"]);
      assert.equal(yield* git("show", ":tracked.txt"), "one\n");

      yield* GitIndexStaging.stagePaths(driver, { cwd });
      assert.deepStrictEqual(yield* files(), ["new file.txt:S", "tracked.txt:S"]);
    }),
  );

  it.effect("unstages next to a file named HEAD", () =>
    Effect.gen(function* () {
      const { cwd, driver, git, write, files } = yield* setupRepo({ commit: true });
      yield* write("HEAD", "a file, not the revision\n");
      yield* git("add", "HEAD");
      yield* git("commit", "-m", "add HEAD file");
      yield* write("HEAD", "changed\n");
      yield* write("tracked.txt", "one\ntwo\n");
      yield* GitIndexStaging.stagePaths(driver, { cwd });
      assert.deepStrictEqual(yield* files(), ["HEAD:S", "tracked.txt:S"]);

      yield* GitIndexStaging.unstagePaths(driver, { cwd, paths: ["HEAD"] });
      assert.deepStrictEqual(yield* files(), ["HEAD:U", "tracked.txt:S"]);
      yield* GitIndexStaging.unstagePaths(driver, { cwd });
      assert.deepStrictEqual(yield* files(), ["HEAD:U", "tracked.txt:U"]);
    }),
  );

  it.effect("unstages in a repository without commits", () =>
    Effect.gen(function* () {
      const { cwd, driver, write, files } = yield* setupRepo({ commit: false });
      yield* write("a.txt", "a\n");
      yield* write("b.txt", "b\n");
      yield* GitIndexStaging.stagePaths(driver, { cwd });
      yield* write("a.txt", "a\nchanged\n");
      assert.deepStrictEqual(yield* files(), ["a.txt:SU", "b.txt:S"]);

      yield* GitIndexStaging.unstagePaths(driver, { cwd, paths: ["a.txt"] });
      assert.deepStrictEqual(yield* files(), ["a.txt:?", "b.txt:S"]);

      yield* GitIndexStaging.unstagePaths(driver, { cwd });
      assert.deepStrictEqual(yield* files(), ["a.txt:?", "b.txt:?"]);
    }),
  );
});
