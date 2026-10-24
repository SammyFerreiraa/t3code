import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { AuthSourceControlWriteScope, type ScopedThreadRef } from "@t3tools/contracts";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { ArrowDownIcon, ArrowUpIcon, GitBranchIcon } from "lucide-react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { vcsEnvironment } from "~/state/vcs";
import GitActionsControl from "../GitActionsControl";
import { SourceControlFileSections } from "./SourceControlFileSections";
import { readSourceControlDraft, useSourceControlDraftStore } from "./sourceControlDraftStore";
import {
  resolveSourceControlPanelState,
  resolveSourceControlSections,
} from "./sourceControlPanel.logic";

function PanelMessage({ children }: { children: string }) {
  return (
    <p className="flex flex-1 items-center justify-center px-6 text-center text-muted-foreground text-sm">
      {children}
    </p>
  );
}

function CommitMessageBox({
  threadRef,
  disabled,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly disabled: boolean;
}) {
  const message = useSourceControlDraftStore(
    (state) => state.byThreadKey[scopedThreadKey(threadRef)]?.message ?? "",
  );
  return (
    <Textarea
      size="sm"
      aria-label="Commit message"
      placeholder="Message (leave empty to auto-generate)"
      value={message}
      disabled={disabled}
      onChange={(event) =>
        useSourceControlDraftStore.getState().update(threadRef, { message: event.target.value })
      }
    />
  );
}

export default function SourceControlPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly gitCwd: string | null;
  readonly onOpenFileDiff: (filePath: string) => void;
}) {
  const { threadRef, gitCwd, onOpenFileDiff } = props;
  const canWrite = useEnvironmentScope(threadRef.environmentId, AuthSourceControlWriteScope);
  const { data: status, error } = useEnvironmentQuery(
    gitCwd === null
      ? null
      : vcsEnvironment.status({ environmentId: threadRef.environmentId, input: { cwd: gitCwd } }),
  );

  if (gitCwd === null) return <PanelMessage>Open a project to use source control.</PanelMessage>;
  if (status === null || status === undefined) {
    return error ? (
      <PanelMessage>{error}</PanelMessage>
    ) : (
      <div className="flex flex-1 items-center justify-center">
        <Spinner aria-label="Loading source control" />
      </div>
    );
  }

  const panelState = resolveSourceControlPanelState(status);
  const sections = resolveSourceControlSections(status.workingTree.files);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <div className="flex min-w-0 items-center gap-2 px-1 text-sm">
        <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-medium">{status.refName ?? "Detached HEAD"}</span>
        {panelState === "not-repo" ? null : status.hasUpstream ? (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-2xs text-muted-foreground tabular-nums">
            <span
              className="flex items-center"
              role="img"
              aria-label={`${status.aheadCount} to push`}
            >
              <ArrowUpIcon className="size-3" aria-hidden />
              {status.aheadCount}
            </span>
            <span
              className="flex items-center"
              role="img"
              aria-label={`${status.behindCount} to pull`}
            >
              <ArrowDownIcon className="size-3" aria-hidden />
              {status.behindCount}
            </span>
          </span>
        ) : (
          <span className="shrink-0 text-muted-foreground text-xs">No upstream</span>
        )}
        <span className="ml-auto flex shrink-0 gap-1 font-mono text-2xs tabular-nums">
          <span className="text-diff-addition">
            +{formatDiffCount(status.workingTree.insertions)}
          </span>
          <span className="text-diff-deletion">
            -{formatDiffCount(status.workingTree.deletions)}
          </span>
        </span>
      </div>
      {panelState === "not-repo" ? (
        <GitActionsControl
          presentation="toolbar"
          displayMode="panel"
          gitCwd={gitCwd}
          activeThreadRef={threadRef}
        />
      ) : (
        <>
          <CommitMessageBox threadRef={threadRef} disabled={!canWrite} />
          <GitActionsControl
            presentation="toolbar"
            displayMode="panel"
            gitCwd={gitCwd}
            activeThreadRef={threadRef}
            commitDraft={{
              getMessage: () => readSourceControlDraft(threadRef).message,
              stagedOnly: sections.staged.length > 0,
              onCommitted: (message) =>
                useSourceControlDraftStore.getState().clearCommitted(threadRef, message),
            }}
          />
          {panelState === "clean" ? (
            <PanelMessage>No changes</PanelMessage>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <SourceControlFileSections
                environmentId={threadRef.environmentId}
                gitCwd={gitCwd}
                sections={sections}
                disabled={!canWrite}
                onOpenFileDiff={onOpenFileDiff}
              />
            </ScrollArea>
          )}
        </>
      )}
    </div>
  );
}
