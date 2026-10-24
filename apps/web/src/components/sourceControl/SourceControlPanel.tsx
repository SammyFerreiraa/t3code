import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AuthSourceControlWriteScope,
  type ScopedThreadRef,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { ArrowDownIcon, ArrowUpIcon, GitBranchIcon } from "lucide-react";
import { memo } from "react";

import { Checkbox } from "~/components/ui/checkbox";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { vcsEnvironment } from "~/state/vcs";
import GitActionsControl from "../GitActionsControl";
import { StartTruncatedPath } from "../StartTruncatedPath";
import {
  EMPTY_SOURCE_CONTROL_DRAFT,
  readSourceControlDraft,
  useSourceControlDraftStore,
} from "./sourceControlDraftStore";
import { resolveCommitFilePaths, resolveSourceControlPanelState } from "./sourceControlPanel.logic";

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

const ChangedFiles = memo(function ChangedFiles({
  threadRef,
  files,
  excluded,
  disabled,
  onOpenFileDiff,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly files: VcsStatusResult["workingTree"]["files"];
  readonly excluded: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onOpenFileDiff: (filePath: string) => void;
}) {
  const toggleFile = (path: string) => {
    const next = new Set(readSourceControlDraft(threadRef).excluded);
    if (!next.delete(path)) next.add(path);
    useSourceControlDraftStore.getState().update(threadRef, { excluded: next });
  };
  return (
    <ScrollArea className="min-h-0 flex-1">
      <ul aria-label="Changed files" className="flex flex-col gap-0.5">
        {files.map((file) => (
          <li
            key={file.path}
            className="flex items-center gap-2 rounded-md px-1.5 py-1 font-mono text-xs hover:bg-accent/50"
          >
            <Checkbox
              aria-label={`Include ${file.path} in commit`}
              checked={!excluded.has(file.path)}
              disabled={disabled}
              onCheckedChange={() => toggleFile(file.path)}
            />
            <button
              type="button"
              className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-3 text-left"
              aria-label={`Open diff of ${file.path}`}
              onClick={() => onOpenFileDiff(file.path)}
            >
              <StartTruncatedPath
                path={file.path}
                className={excluded.has(file.path) ? "flex-1 text-muted-foreground" : "flex-1"}
              />
              <span className="shrink-0">
                <span className="text-diff-addition">+{formatDiffCount(file.insertions)}</span>
                <span className="text-muted-foreground"> / </span>
                <span className="text-diff-deletion">-{formatDiffCount(file.deletions)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
});

export default function SourceControlPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly gitCwd: string | null;
  readonly onOpenFileDiff: (filePath: string) => void;
}) {
  const { threadRef, gitCwd, onOpenFileDiff } = props;
  const excluded = useSourceControlDraftStore(
    (state) =>
      state.byThreadKey[scopedThreadKey(threadRef)]?.excluded ??
      EMPTY_SOURCE_CONTROL_DRAFT.excluded,
  );
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
  const files = status.workingTree.files;
  const filePaths = resolveCommitFilePaths(files, excluded);
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
              filePaths,
              onCommitted: () => useSourceControlDraftStore.getState().clear(threadRef),
            }}
          />
          {panelState === "clean" ? (
            <PanelMessage>No changes</PanelMessage>
          ) : (
            <ChangedFiles
              threadRef={threadRef}
              files={files}
              excluded={excluded}
              disabled={!canWrite}
              onOpenFileDiff={onOpenFileDiff}
            />
          )}
        </>
      )}
    </div>
  );
}
