import type { GitStackedAction, VcsStatusResult } from "@t3tools/contracts";
import { changeRequestTerminologyFor } from "@t3tools/client-runtime/state/vcs";

type ChangedFile = VcsStatusResult["workingTree"]["files"][number];

/** What the Source Control tab hands the git actions control so commits use its message and index. */
export interface SourceControlCommitDraft {
  /** Read on click, so typing never re-renders the git actions control. */
  readonly getMessage: () => string;
  /** Like VS Code: with something staged, commit only the index; otherwise commit everything. */
  readonly stagedOnly: boolean;
  /** Gets the message that was sent, so edits made while the action ran are not discarded. */
  readonly onCommitted: (committedMessage: string) => void;
}

export type SourceControlPanelState = "loading" | "not-repo" | "clean" | "changes";

export function resolveSourceControlPanelState(
  status: VcsStatusResult | null,
): SourceControlPanelState {
  if (status === null) return "loading";
  if (!status.isRepo) return "not-repo";
  return status.hasWorkingTreeChanges ? "changes" : "clean";
}

export interface SourceControlSectionFile {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
}

export interface SourceControlSections {
  readonly staged: SourceControlSectionFile[];
  readonly changes: SourceControlSectionFile[];
  readonly untracked: SourceControlSectionFile[];
}

/**
 * A partially staged file sits in both Staged and Changes with each side's line counts. Files
 * without index state come from a server that predates staging and stay in Changes.
 */
export function resolveSourceControlSections(
  files: ReadonlyArray<ChangedFile>,
): SourceControlSections {
  const sections: SourceControlSections = { staged: [], changes: [], untracked: [] };
  for (const file of files) {
    if (file.untracked) {
      sections.untracked.push({ path: file.path, insertions: 0, deletions: 0 });
      continue;
    }
    if (file.staged) sections.staged.push({ path: file.path, ...file.staged });
    if (file.unstaged) sections.changes.push({ path: file.path, ...file.unstaged });
    else if (!file.staged) sections.changes.push(file);
  }
  return sections;
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
