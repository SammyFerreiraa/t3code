import type { GitStackedAction, VcsStatusResult } from "@t3tools/contracts";
import { changeRequestTerminologyFor } from "@t3tools/client-runtime/state/vcs";

type ChangedFile = VcsStatusResult["workingTree"]["files"][number];

/** What the Source Control tab hands the git actions control so commits use its message and selection. */
export interface SourceControlCommitDraft {
  /** Read on click, so typing never re-renders the git actions control. */
  readonly getMessage: () => string;
  readonly filePaths: string[] | null;
  readonly onCommitted: () => void;
}

export type SourceControlPanelState = "loading" | "not-repo" | "clean" | "changes";

export function resolveSourceControlPanelState(
  status: VcsStatusResult | null,
): SourceControlPanelState {
  if (status === null) return "loading";
  if (!status.isRepo) return "not-repo";
  return status.hasWorkingTreeChanges ? "changes" : "clean";
}

/** `null` means every file is included, which is what the server does without `filePaths`. */
export function resolveCommitFilePaths(
  files: ReadonlyArray<ChangedFile>,
  excluded: ReadonlySet<string>,
): string[] | null {
  const kept = files.filter((file) => !excluded.has(file.path));
  return kept.length === files.length ? null : kept.map((file) => file.path);
}

export interface SourceControlMenuExtra {
  readonly id: "commit_push" | "commit_push_pr" | "pull";
  readonly label: string;
  readonly action: GitStackedAction | "pull";
  readonly disabledReason: string | null;
}

/**
 * Actions the header menu lacks. The header's Commit, Push and Create PR items come from
 * `buildMenuItems`; these extend them when the panel owns the commit message.
 */
export function resolveSourceControlMenuExtras(
  status: VcsStatusResult,
  isBusy: boolean,
  hasSelectedFiles: boolean,
): SourceControlMenuExtra[] {
  const terminology = changeRequestTerminologyFor(status);
  const busy = isBusy ? "Git action in progress." : null;
  const isBehind = status.behindCount > 0;
  const canReachRemote = status.hasUpstream || status.hasPrimaryRemote;

  const commitReason =
    busy ??
    (status.refName === null
      ? "Detached HEAD: check out a branch before pushing."
      : !status.hasWorkingTreeChanges
        ? "Worktree is clean. Make changes before committing."
        : !hasSelectedFiles
          ? "Select at least one file to commit."
          : !canReachRemote
            ? 'Add an "origin" remote before pushing.'
            : isBehind
              ? "Branch is behind upstream. Pull/rebase before pushing."
              : null);

  const extras: SourceControlMenuExtra[] = [
    {
      id: "commit_push",
      label: "Commit & push",
      action: "commit_push",
      disabledReason: commitReason,
    },
  ];
  // The header commits straight to the default ref there, so a PR from it makes no sense.
  if (status.pr?.state !== "open" && !status.isDefaultRef) {
    extras.push({
      id: "commit_push_pr",
      label: `Commit, push & ${terminology.shortLabel}`,
      action: "commit_push_pr",
      disabledReason: commitReason,
    });
  }
  extras.push({
    id: "pull",
    label: "Pull",
    action: "pull",
    disabledReason:
      busy ??
      (!status.hasUpstream
        ? "This branch has no upstream to pull from."
        : status.aheadCount > 0 && isBehind
          ? "Branch has diverged from upstream. Rebase/merge first."
          : !isBehind
            ? "Branch is not behind upstream."
            : null),
  });
  return extras;
}
