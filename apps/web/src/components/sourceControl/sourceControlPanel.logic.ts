import type { VcsStatusResult } from "@t3tools/contracts";
import { changeRequestTerminologyFor } from "@t3tools/client-runtime/state/vcs";

import type { GitQuickAction } from "../GitActionsControl.logic";

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

const BEHIND_PUSH_REASON = "Branch is behind upstream. Pull/rebase before pushing.";

/**
 * The header's quick action offers to commit and push on a branch that is behind, which its own
 * Push item refuses. The tab's menu follows that refusal, so its main button does too.
 */
export function resolveSourceControlQuickAction(
  quickAction: GitQuickAction,
  status: VcsStatusResult | null,
): GitQuickAction {
  if (
    status !== null &&
    status.behindCount > 0 &&
    quickAction.kind === "run_action" &&
    (quickAction.action === "commit_push" || quickAction.action === "commit_push_pr")
  ) {
    return { ...quickAction, kind: "show_hint", disabled: true, hint: BEHIND_PUSH_REASON };
  }
  return quickAction;
}

/** A git error as the tab shows it: the explanation, without the service name and the path. */
export function describeSourceControlError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "detail" in error &&
    typeof error.detail === "string" &&
    error.detail.length > 0
  ) {
    return error.detail;
  }
  return error instanceof Error ? error.message : "An error occurred.";
}

export type SourceControlMenuExtraId =
  | "commit_push"
  | "commit_push_pr"
  | "commit_sync"
  | "force_push"
  | "pull"
  | "sync"
  | "rebase"
  | "fetch"
  | "publish_branch";

export interface SourceControlMenuExtra {
  readonly id: SourceControlMenuExtraId;
  readonly label: string;
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
  const detached =
    status.refName === null ? "Detached HEAD: check out a branch before pushing." : null;
  const isBehind = status.behindCount > 0;
  const isDiverged = status.aheadCount > 0 && isBehind;
  const canReachRemote = status.hasUpstream || status.hasPrimaryRemote;
  const clean = !status.hasWorkingTreeChanges
    ? "Worktree is clean. Make changes before committing."
    : null;
  const noRemote = !canReachRemote ? 'Add an "origin" remote before pushing.' : null;
  const noUpstream = !status.hasUpstream ? "Publish the branch before syncing." : null;
  const divergedReason = isDiverged
    ? "Branch has diverged from upstream. Rebase/merge first."
    : null;

  const commitReason =
    busy ?? detached ?? clean ?? noRemote ?? (isBehind ? BEHIND_PUSH_REASON : null);

  const extras: SourceControlMenuExtra[] = [
    { id: "commit_push", label: "Commit & push", disabledReason: commitReason },
  ];
  // The header commits straight to the default ref there, so a PR from it makes no sense.
  if (status.pr?.state !== "open" && !status.isDefaultRef) {
    extras.push({
      id: "commit_push_pr",
      label: `Commit, push & ${terminology.shortLabel}`,
      disabledReason: commitReason,
    });
  }
  extras.push(
    {
      id: "commit_sync",
      label: "Commit & sync",
      // Committing on top of a behind branch diverges it, so the sync's pull could only fail.
      disabledReason:
        busy ??
        detached ??
        clean ??
        noUpstream ??
        (isBehind ? "Branch is behind upstream. Pull before committing and syncing." : null),
    },
    {
      id: "force_push",
      label: "Force push",
      disabledReason:
        busy ??
        detached ??
        (status.isDefaultRef
          ? "Force push is blocked on the default branch."
          : !status.hasUpstream
            ? "Publish the branch before force pushing."
            : status.aheadCount === 0 && !isBehind
              ? "Branch already matches its upstream."
              : null),
    },
    {
      id: "pull",
      label: "Pull",
      disabledReason:
        busy ??
        (!status.hasUpstream
          ? "This branch has no upstream to pull from."
          : (divergedReason ?? (!isBehind ? "Branch is not behind upstream." : null))),
    },
    { id: "sync", label: "Sync", disabledReason: busy ?? detached ?? noUpstream ?? divergedReason },
    {
      id: "rebase",
      label: `Rebase from ${status.defaultRef ?? "default branch"}`,
      disabledReason:
        busy ??
        detached ??
        (status.isDefaultRef
          ? "Already on the default branch."
          : !status.hasPrimaryRemote
            ? "Add a remote to rebase from its default branch."
            : status.hasWorkingTreeChanges
              ? "Commit or stash changes before rebasing."
              : null),
    },
    {
      id: "fetch",
      label: "Fetch",
      disabledReason: busy ?? (!canReachRemote ? "Add a remote before fetching." : null),
    },
    {
      id: "publish_branch",
      label: "Publish branch",
      disabledReason:
        busy ??
        detached ??
        (status.hasUpstream
          ? "Branch is already published."
          : !status.hasPrimaryRemote
            ? 'Add an "origin" remote before publishing.'
            : null),
    },
  );
  return extras;
}
