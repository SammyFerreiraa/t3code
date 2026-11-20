import type { VcsStatusResult } from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { changeRequestTerminologyFor } from "@t3tools/client-runtime/state/vcs";

import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
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

/**
 * The header's quick action offers to commit and push on a branch that is behind, which its own
 * Push item refuses. The tab's menu follows that refusal, so its main button falls back to what
 * is possible: a local commit. Without changes the header already offers Pull, or says to
 * rebase/merge first when diverged.
 */
export function resolveSourceControlQuickAction(
  quickAction: GitQuickAction,
  status: VcsStatusResult | null,
  resolve: MessageResolver = m,
): GitQuickAction {
  if (
    status !== null &&
    status.behindCount > 0 &&
    quickAction.kind === "run_action" &&
    (quickAction.action === "commit_push" || quickAction.action === "commit_push_pr")
  ) {
    return {
      label: resolve(msg("Commit", { $context: "verb, git action" })),
      disabled: false,
      kind: "run_action",
      action: "commit",
    };
  }
  return quickAction;
}

/** A git error as the tab shows it: the explanation, without the service name and the path. */
export function describeSourceControlError(error: unknown, resolve: MessageResolver = m): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "detail" in error &&
    typeof error.detail === "string" &&
    error.detail.length > 0
  ) {
    return error.detail;
  }
  return thrownErrorMessage(error, resolve) ?? resolve(msg("An error occurred."));
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
  resolve: MessageResolver = m,
): SourceControlMenuExtra[] {
  const terminology = changeRequestTerminologyFor(status);
  const busy = isBusy ? resolve(msg("Git action in progress.")) : null;
  const detached =
    status.refName === null
      ? resolve(msg("Detached HEAD: check out a branch before pushing."))
      : null;
  const isBehind = status.behindCount > 0;
  const isDiverged = status.aheadCount > 0 && isBehind;
  const canReachRemote = status.hasUpstream || status.hasPrimaryRemote;
  const clean = !status.hasWorkingTreeChanges
    ? resolve(msg("Worktree is clean. Make changes before committing."))
    : null;
  const noRemote = !canReachRemote ? resolve(msg('Add an "origin" remote before pushing.')) : null;
  const noUpstream = !status.hasUpstream
    ? resolve(msg("Publish the branch before syncing."))
    : null;
  const divergedReason = isDiverged
    ? resolve(msg("Branch has diverged from upstream. Rebase/merge first."))
    : null;

  const commitReason =
    busy ??
    detached ??
    clean ??
    noRemote ??
    (isBehind ? resolve(msg("Branch is behind upstream. Pull/rebase before pushing.")) : null);

  const extras: SourceControlMenuExtra[] = [
    {
      id: "commit_push",
      label: resolve(msg("Commit & push")),
      disabledReason: commitReason,
    },
  ];
  // The header commits straight to the default ref there, so a PR from it makes no sense.
  if (status.pr?.state !== "open" && !status.isDefaultRef) {
    extras.push({
      id: "commit_push_pr",
      label: resolve(msg("Commit, push & {shortLabel}", { shortLabel: terminology.shortLabel })),
      disabledReason: commitReason,
    });
  }
  extras.push(
    {
      id: "commit_sync",
      label: resolve(msg("Commit & sync")),
      // Committing on top of a behind branch diverges it, so the sync's pull could only fail.
      disabledReason:
        busy ??
        detached ??
        clean ??
        noUpstream ??
        (isBehind
          ? resolve(msg("Branch is behind upstream. Pull before committing and syncing."))
          : null),
    },
    {
      id: "force_push",
      label: resolve(msg("Force push")),
      disabledReason:
        busy ??
        detached ??
        (status.isDefaultRef
          ? resolve(msg("Force push is blocked on the default branch."))
          : !status.hasUpstream
            ? resolve(msg("Publish the branch before force pushing."))
            : status.aheadCount === 0 && !isBehind
              ? resolve(msg("Branch already matches its upstream."))
              : null),
    },
    {
      id: "pull",
      label: resolve(msg("Pull")),
      disabledReason:
        busy ??
        (!status.hasUpstream
          ? resolve(msg("This branch has no upstream to pull from."))
          : (divergedReason ??
            (!isBehind ? resolve(msg("Branch is not behind upstream.")) : null))),
    },
    {
      id: "sync",
      label: resolve(msg("Sync")),
      disabledReason: busy ?? detached ?? noUpstream ?? divergedReason,
    },
    {
      id: "rebase",
      label: resolve(
        msg("Rebase from {base}", { base: status.defaultRef ?? resolve(msg("default branch")) }),
      ),
      disabledReason:
        busy ??
        detached ??
        (status.isDefaultRef
          ? resolve(msg("Already on the default branch."))
          : !status.hasPrimaryRemote
            ? resolve(msg("Add a remote to rebase from its default branch."))
            : status.hasWorkingTreeChanges
              ? resolve(msg("Commit or stash changes before rebasing."))
              : null),
    },
    {
      id: "fetch",
      label: resolve(msg("Fetch")),
      disabledReason:
        busy ?? (!canReachRemote ? resolve(msg("Add a remote before fetching.")) : null),
    },
    {
      id: "publish_branch",
      label: resolve(msg("Publish branch")),
      disabledReason:
        busy ??
        detached ??
        (status.hasUpstream
          ? resolve(msg("Branch is already published."))
          : !status.hasPrimaryRemote
            ? resolve(msg('Add an "origin" remote before publishing.'))
            : null),
    },
  );
  return extras;
}
