import { GitCommandError, type VcsRebaseOntoDefaultResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

type Git = GitVcsDriver.GitVcsDriver["Service"];

const REBASE_TIMEOUT_MS = 5 * 60_000;

const failure = (operation: string, cwd: string, detail: string, exitCode?: number | null) =>
  new GitCommandError({
    operation,
    command: "git",
    cwd,
    detail,
    ...(exitCode === undefined || exitCode === null ? {} : { exitCode }),
  });

const readCurrentBranch = (git: Git, cwd: string) =>
  git
    .execute({
      operation: "GitRemoteSync.currentBranch",
      cwd,
      args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
      allowNonZeroExit: true,
    })
    .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)));

const requireCurrentBranch = Effect.fn("GitRemoteSync.requireCurrentBranch")(function* (
  git: Git,
  cwd: string,
  operation: string,
) {
  const branch = yield* readCurrentBranch(git, cwd);
  if (branch === null) {
    return yield* failure(operation, cwd, "HEAD is detached. Check out a branch first.");
  }
  return branch;
});

// `.` marks a branch that tracks another local branch, which has no remote to talk to.
const readBranchRemote = (git: Git, cwd: string, branch: string) =>
  git
    .readConfigValue(cwd, `branch.${branch}.remote`)
    .pipe(Effect.map((remote) => (remote && remote !== "." ? remote : null)));

/** Fetches the current branch's remote, or the primary one, and prunes deleted branches. */
export const fetchBranchRemote = Effect.fn("GitRemoteSync.fetchBranchRemote")(function* (
  git: Git,
  cwd: string,
) {
  const branch = yield* readCurrentBranch(git, cwd);
  const remoteName =
    (branch === null ? null : yield* readBranchRemote(git, cwd, branch)) ??
    (yield* git.resolvePrimaryRemoteName(cwd));
  yield* git.fetchRemote({ cwd, remoteName, prune: true });
});

/**
 * Overwrites the upstream with HEAD, but only while every upstream commit is one this branch
 * already had. The lease alone compares against the remote-tracking ref, which the background
 * status fetch keeps current, so `--force-if-includes` is what keeps unpulled commits safe.
 */
export const forcePushWithLease = Effect.fn("GitRemoteSync.forcePushWithLease")(function* (
  git: Git,
  cwd: string,
) {
  const operation = "GitRemoteSync.forcePushWithLease";
  const branch = yield* requireCurrentBranch(git, cwd, operation);
  const details = yield* git.statusDetailsLocal(cwd);
  if (details.isDefaultBranch) {
    return yield* failure(operation, cwd, "Force push is blocked on the default branch.");
  }
  const [remoteName, mergeRef] = yield* Effect.all([
    readBranchRemote(git, cwd, branch),
    git.readConfigValue(cwd, `branch.${branch}.merge`),
  ]);
  const target = mergeRef?.startsWith("refs/heads/") ? mergeRef.slice("refs/heads/".length) : null;
  if (remoteName === null || target === null) {
    return yield* failure(operation, cwd, "This branch has no upstream. Publish it first.");
  }
  // A branch cut from `origin/main` tracks its base, and a local branch named `origin/main` can
  // track main itself. Forcing HEAD there would rewrite a shared branch, so only an upstream with
  // the branch's own name can be overwritten.
  if (target !== branch) {
    return yield* failure(
      operation,
      cwd,
      `This branch tracks ${remoteName}/${target}. Push it normally once to publish it under its own name.`,
    );
  }
  const result = yield* git.execute({
    operation,
    cwd,
    args: [
      "push",
      "--force-with-lease",
      "--force-if-includes",
      "--",
      remoteName,
      `HEAD:refs/heads/${target}`,
    ],
    allowNonZeroExit: true,
    timeoutMs: null,
  });
  if (result.exitCode !== 0) {
    // stderr can echo remote URLs with credentials, so only a fixed diagnosis leaves here.
    return yield* failure(
      operation,
      cwd,
      /\((?:stale info|remote ref updated since checkout)\)/.test(result.stderr)
        ? "The remote branch has commits you have not pulled. Pull or rebase them in, then force push again."
        : "git push --force-with-lease failed.",
      result.exitCode,
    );
  }
  return {
    status: "pushed" as const,
    branch,
    upstreamBranch: `${remoteName}/${target}`,
    setUpstream: false,
  };
});

/**
 * Rebases the current branch onto the freshly fetched default branch of the primary remote.
 * A rebase that stops on conflicts is aborted, so the repository is never left mid-rebase.
 */
export const rebaseOntoDefault = Effect.fn("GitRemoteSync.rebaseOntoDefault")(function* (
  git: Git,
  cwd: string,
) {
  const operation = "GitRemoteSync.rebaseOntoDefault";
  const branch = yield* requireCurrentBranch(git, cwd, operation);
  const changes = yield* git.execute({
    operation: `${operation}.status`,
    cwd,
    args: ["status", "--porcelain"],
  });
  if (changes.stdout.trim().length > 0) {
    return yield* failure(operation, cwd, "Commit or stash your changes before rebasing.");
  }
  const remoteName = yield* git.resolvePrimaryRemoteName(cwd);
  yield* git.fetchRemote({ cwd, remoteName });
  const defaultBranch =
    (yield* git.resolveDefaultBranchName(cwd, remoteName)) ??
    ((yield* git.remoteBranchExists({ cwd, remoteName, refName: "main" }))
      ? "main"
      : (yield* git.remoteBranchExists({ cwd, remoteName, refName: "master" }))
        ? "master"
        : null);
  if (defaultBranch === null) {
    return yield* failure(operation, cwd, `Could not find the default branch on ${remoteName}.`);
  }
  if (defaultBranch === branch) {
    return yield* failure(operation, cwd, "This is already the default branch.");
  }
  const baseRef = `${remoteName}/${defaultBranch}`;
  const readHead = git
    .execute({ operation: `${operation}.head`, cwd, args: ["rev-parse", "HEAD"] })
    .pipe(Effect.map((result) => result.stdout.trim()));
  const before = yield* readHead;

  // Uninterruptible so a dropped request cannot stop between a failed rebase and its abort.
  yield* Effect.gen(function* () {
    const rebase = yield* git
      .execute({
        operation,
        cwd,
        args: ["rebase", `refs/remotes/${baseRef}`],
        allowNonZeroExit: true,
        timeoutMs: REBASE_TIMEOUT_MS,
      })
      .pipe(Effect.orElseSucceed(() => ({ exitCode: null })));
    if (rebase.exitCode === 0) return;
    const abort = yield* git.execute({
      operation: `${operation}.abort`,
      cwd,
      args: ["rebase", "--abort"],
      allowNonZeroExit: true,
    });
    return yield* failure(
      operation,
      cwd,
      abort.exitCode === 0
        ? `Rebasing onto ${baseRef} hit conflicts, so it was aborted and the branch is unchanged. Rebase in a terminal to resolve them.`
        : "git rebase failed. If a rebase is still in progress, run `git rebase --abort` in a terminal.",
      rebase.exitCode,
    );
  }).pipe(Effect.uninterruptible);

  const after = yield* readHead;
  return {
    status: before === after ? "skipped_up_to_date" : "rebased",
    baseRef,
  } satisfies VcsRebaseOntoDefaultResult;
});
