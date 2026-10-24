import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronRightIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { useSourceControlActionRunning } from "~/state/sourceControlActions";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { StartTruncatedPath } from "../StartTruncatedPath";
import type { SourceControlSectionFile, SourceControlSections } from "./sourceControlPanel.logic";

type IndexAction = "stage" | "unstage";
type RunIndexAction = (action: IndexAction, paths?: string[]) => void;

function FileSection({
  title,
  files,
  action,
  showCounts,
  disabled,
  onIndexAction,
  onOpenFileDiff,
  allPaths,
}: {
  readonly title: string;
  readonly files: ReadonlyArray<SourceControlSectionFile>;
  readonly action: IndexAction;
  readonly showCounts: boolean;
  readonly disabled: boolean;
  readonly onIndexAction: RunIndexAction;
  readonly onOpenFileDiff: (filePath: string) => void;
  /** `undefined` acts on the whole repository, which is what Unstage All needs. */
  readonly allPaths: string[] | undefined;
}) {
  const [expanded, setExpanded] = useState(true);
  if (files.length === 0) return null;
  const verb = action === "stage" ? "Stage" : "Unstage";
  const ActionIcon = action === "stage" ? PlusIcon : MinusIcon;
  return (
    <section aria-label={title} className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1 pe-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md px-0.5 py-1 text-left font-medium text-muted-foreground text-xs"
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 shrink-0", expanded && "rotate-90")}
          />
          <span className="truncate">{title}</span>
          <span className="tabular-nums">{files.length}</span>
        </button>
        <Button
          variant="ghost"
          size="icon-micro"
          aria-label={`${verb} all ${title.toLowerCase()}`}
          disabled={disabled}
          onClick={() => onIndexAction(action, allPaths)}
        >
          <ActionIcon />
        </Button>
      </div>
      {expanded ? (
        <ul className="flex flex-col gap-0.5">
          {files.map((file) => (
            <li
              key={file.path}
              className="group/row flex items-center gap-2 rounded-md px-1.5 py-1 font-mono text-xs hover:bg-accent/50"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-3 text-left"
                aria-label={`Open diff of ${file.path}`}
                onClick={() => onOpenFileDiff(file.path)}
              >
                <StartTruncatedPath path={file.path} className="flex-1" />
                {showCounts ? (
                  <span className="shrink-0">
                    <span className="text-diff-addition">+{formatDiffCount(file.insertions)}</span>
                    <span className="text-muted-foreground"> / </span>
                    <span className="text-diff-deletion">-{formatDiffCount(file.deletions)}</span>
                  </span>
                ) : null}
              </button>
              <span className="flex shrink-0 opacity-0 pointer-coarse:opacity-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100">
                <Button
                  variant="ghost"
                  size="icon-micro"
                  aria-label={`${verb} ${file.path}`}
                  disabled={disabled}
                  onClick={() => onIndexAction(action, [file.path])}
                >
                  <ActionIcon />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function SourceControlFileSections({
  environmentId,
  gitCwd,
  sections,
  disabled,
  onOpenFileDiff,
}: {
  readonly environmentId: EnvironmentId;
  readonly gitCwd: string;
  readonly sections: SourceControlSections;
  readonly disabled: boolean;
  readonly onOpenFileDiff: (filePath: string) => void;
}) {
  const stage = useAtomCommand(vcsEnvironment.stage, "Stage changes");
  const unstage = useAtomCommand(vcsEnvironment.unstage, "Unstage changes");
  const [isIndexActionPending, setIndexActionPending] = useState(false);
  // A commit, pull or rebase rewrites the index, so editing it meanwhile would race them.
  const isGitActionRunning = useSourceControlActionRunning({ environmentId, cwd: gitCwd }, [
    "runStackedAction",
    "pull",
    "rebase",
  ]);
  const onIndexAction: RunIndexAction = (action, paths) => {
    setIndexActionPending(true);
    void (action === "stage" ? stage : unstage)({
      environmentId,
      input: { cwd: gitCwd, ...(paths ? { paths } : {}) },
    }).finally(() => setIndexActionPending(false));
  };
  const shared = {
    disabled: disabled || isIndexActionPending || isGitActionRunning,
    onIndexAction,
    onOpenFileDiff,
  };
  return (
    <div className="flex flex-col gap-1">
      {/* Staged files open the working tree diff: the diff panel has no index-only view. */}
      <FileSection
        {...shared}
        title="Staged Changes"
        files={sections.staged}
        action="unstage"
        showCounts
        allPaths={undefined}
      />
      <FileSection
        {...shared}
        title="Changes"
        files={sections.changes}
        action="stage"
        showCounts
        allPaths={sections.changes.map((file) => file.path)}
      />
      <FileSection
        {...shared}
        title="Untracked"
        files={sections.untracked}
        action="stage"
        showCounts={false}
        allPaths={sections.untracked.map((file) => file.path)}
      />
    </div>
  );
}
