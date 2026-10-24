import {
  GitCommandError,
  GitCommitSha,
  type VcsCommit,
  type VcsCommitFile,
  type VcsCommitFilesInput,
  type VcsCommitFilesResult,
  type VcsCommitRef,
  type VcsLogInput,
  type VcsLogResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

type Git = GitVcsDriver.GitVcsDriver["Service"];

const DEFAULT_LIMIT = 30;
const MAX_COMMIT_FILES = 500;
const FIELD_SEPARATOR = "\x1f";

const isCommitSha = Schema.is(GitCommitSha);

const failure = (operation: string, cwd: string, detail: string, exitCode?: number | null) =>
  new GitCommandError({
    operation,
    command: "git",
    cwd,
    detail,
    ...(exitCode === undefined || exitCode === null ? {} : { exitCode }),
  });

// `--decorate=full` keeps a branch named `tags/x` or `origin/x` from passing for another kind.
const parseRefs = (decoration: string): VcsCommitRef[] => {
  const refs: VcsCommitRef[] = [];
  for (const entry of decoration.split(", ")) {
    if (entry.length === 0) continue;
    if (entry === "HEAD") {
      refs.push({ name: "HEAD", kind: "head" });
    } else if (entry.startsWith("HEAD -> refs/heads/")) {
      refs.push({ name: entry.slice("HEAD -> refs/heads/".length), kind: "head" });
    } else if (entry.startsWith("tag: refs/tags/")) {
      refs.push({ name: entry.slice("tag: refs/tags/".length), kind: "tag" });
    } else if (entry.startsWith("refs/heads/")) {
      refs.push({ name: entry.slice("refs/heads/".length), kind: "branch" });
    } else if (entry.startsWith("refs/remotes/") && !entry.endsWith("/HEAD")) {
      refs.push({ name: entry.slice("refs/remotes/".length), kind: "remote" });
    }
  }
  return refs;
};

// Commits are NUL-separated and fields are unit-separated. The subject is last and rejoined,
// so even a subject holding a unit separator survives.
const parseCommits = (stdout: string): VcsCommit[] =>
  stdout.split("\0").flatMap((record) => {
    const [sha, shortSha, authorName, authoredAt, decoration, ...subject] =
      record.split(FIELD_SEPARATOR);
    if (!sha || !shortSha || authorName === undefined || !authoredAt || decoration === undefined) {
      return [];
    }
    return [
      {
        sha,
        shortSha,
        subject: subject.join(FIELD_SEPARATOR),
        authorName,
        authoredAt,
        refs: parseRefs(decoration),
      },
    ];
  });

/** Newest-first history of HEAD. A repository without commits has an empty history. */
export const readLog = Effect.fn("GitCommitLog.readLog")(function* (git: Git, input: VcsLogInput) {
  const operation = "GitCommitLog.readLog";
  const limit = input.limit ?? DEFAULT_LIMIT;
  const skip = input.cursor ?? 0;
  const result = yield* git.execute({
    operation,
    cwd: input.cwd,
    args: [
      "log",
      "--no-show-signature",
      "--decorate=full",
      "-z",
      `--format=%H%x1f%h%x1f%an%x1f%aI%x1f%D%x1f%s`,
      `--skip=${skip}`,
      // One extra row tells whether another page exists.
      `--max-count=${limit + 1}`,
      "HEAD",
      "--",
    ],
    allowNonZeroExit: true,
  });
  if (result.exitCode !== 0) {
    const head = yield* git.execute({
      operation: `${operation}.head`,
      cwd: input.cwd,
      args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      allowNonZeroExit: true,
    });
    if (head.exitCode === 0) {
      return yield* failure(
        operation,
        input.cwd,
        "Could not read the commit history.",
        result.exitCode,
      );
    }
    return { commits: [], nextCursor: null } satisfies VcsLogResult;
  }
  const commits = parseCommits(result.stdout);
  const hasMore = commits.length > limit;
  return {
    commits: hasMore ? commits.slice(0, limit) : commits,
    nextCursor: hasMore ? skip + limit : null,
  } satisfies VcsLogResult;
});

const STATUS_BY_LETTER = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
} as const satisfies Record<string, VcsCommitFile["status"]>;

// `--name-status -z` prints `<status>\0<path>\0`, and renames and copies add a second path.
const parseNameStatus = (stdout: string): VcsCommitFile[] => {
  const tokens = stdout.split("\0");
  const files: VcsCommitFile[] = [];
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index++] ?? "";
    const letter = code[0] as keyof typeof STATUS_BY_LETTER | undefined;
    const status = letter ? STATUS_BY_LETTER[letter] : undefined;
    if (!status) continue;
    const hasSource = letter === "R" || letter === "C";
    const first = tokens[index++];
    const second = hasSource ? tokens[index++] : undefined;
    const path = hasSource ? second : first;
    if (!path) continue;
    files.push({ path, previousPath: hasSource && first ? first : null, status });
  }
  return files;
};

/** Files a commit changed. A merge is compared with its first parent, a root commit with nothing. */
export const readCommitFiles = Effect.fn("GitCommitLog.readCommitFiles")(function* (
  git: Git,
  input: VcsCommitFilesInput,
) {
  const operation = "GitCommitLog.readCommitFiles";
  if (!isCommitSha(input.sha)) {
    return yield* failure(operation, input.cwd, "Not a commit hash.");
  }
  const result = yield* git.execute({
    operation,
    cwd: input.cwd,
    args: [
      "log",
      "-1",
      "-m",
      "--first-parent",
      "--no-show-signature",
      "--root",
      "-M",
      "--name-status",
      "-z",
      "--format=",
      `${input.sha}^{commit}`,
      "--",
    ],
    allowNonZeroExit: true,
  });
  if (result.exitCode !== 0) {
    return yield* failure(
      operation,
      input.cwd,
      "Could not read the commit's files.",
      result.exitCode,
    );
  }
  const files = parseNameStatus(result.stdout);
  return {
    files: files.slice(0, MAX_COMMIT_FILES),
    truncated: files.length > MAX_COMMIT_FILES,
  } satisfies VcsCommitFilesResult;
});
