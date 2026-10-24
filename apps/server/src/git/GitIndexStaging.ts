import type { VcsIndexInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

type Git = GitVcsDriver.GitVcsDriver["Service"];

// Status paths are repository-relative while cwd can be a subdirectory. Paths go through stdin
// so staging a whole section cannot overflow the command line on Windows. Without paths the
// pathspec is the whole repository.
const pathspecArgs = (input: VcsIndexInput) =>
  input.paths
    ? {
        flags: ["--pathspec-from-file=-", "--pathspec-file-nul"],
        pathspec: [],
        stdin: `${input.paths.map((file) => `:(top,literal)${file}`).join("\0")}\0`,
      }
    : { flags: [], pathspec: [":/"] };

export const stagePaths = Effect.fn("GitIndexStaging.stagePaths")(function* (
  git: Git,
  input: VcsIndexInput,
) {
  const pathspec = pathspecArgs(input);
  yield* git.execute({
    operation: "GitIndexStaging.stagePaths",
    cwd: input.cwd,
    args: ["add", "-A", ...pathspec.flags, "--", ...pathspec.pathspec],
    ...(pathspec.stdin ? { stdin: pathspec.stdin } : {}),
  });
});

export const unstagePaths = Effect.fn("GitIndexStaging.unstagePaths")(function* (
  git: Git,
  input: VcsIndexInput,
) {
  const head = yield* git.execute({
    operation: "GitIndexStaging.unstagePaths.head",
    cwd: input.cwd,
    args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    allowNonZeroExit: true,
  });
  const pathspec = pathspecArgs(input);
  yield* git.execute({
    operation: "GitIndexStaging.unstagePaths",
    cwd: input.cwd,
    // Before the first commit there is no HEAD to reset to, so every staged file is new and
    // unstaging it means dropping it from the index. -f because the index copy may differ
    // from the worktree, which plain `rm --cached` refuses; the worktree file is kept.
    args:
      head.exitCode === 0
        ? // `--` after HEAD keeps a file named HEAD from making the revision ambiguous.
          ["reset", "-q", ...pathspec.flags, "HEAD", "--", ...pathspec.pathspec]
        : [
            "rm",
            "--cached",
            "-r",
            "-f",
            "-q",
            "--ignore-unmatch",
            ...pathspec.flags,
            "--",
            ...pathspec.pathspec,
          ],
    ...(pathspec.stdin ? { stdin: pathspec.stdin } : {}),
  });
});
