import type { EnvironmentId, ScopedThreadRef, VcsCommit, VcsCommitFile } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { StartTruncatedPath } from "../StartTruncatedPath";
import { COMMIT_FILE_STATUS_LETTER, orderCommitRefs } from "./sourceControlCommits.logic";
import {
  readSourceControlCommitsUi,
  useSourceControlCommitsStore,
} from "./sourceControlCommitsStore";

const VISIBLE_REFS = 2;
const REF_BADGE_VARIANT = {
  head: "info",
  branch: "secondary",
  remote: "outline",
  tag: "warning",
} as const;

function QueryError({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-1.5 py-1 text-xs">
      <span className="min-w-0 flex-1 text-destructive-foreground">{message}</span>
      <Button size="xs" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

type OpenCommitFile = (sha: string, file: VcsCommitFile) => void;

function CommitFiles({
  environmentId,
  cwd,
  sha,
  onOpenCommitFile,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly sha: string;
  readonly onOpenCommitFile: OpenCommitFile;
}) {
  const files = useEnvironmentQuery(
    vcsEnvironment.commitFiles({ environmentId, input: { cwd, sha } }),
  );
  if (files.data === null) {
    return files.error ? (
      <QueryError message={files.error} onRetry={files.refresh} />
    ) : (
      <Spinner aria-label="Loading files" className="ms-6 my-1 size-3.5" />
    );
  }
  return (
    <>
      <ul className="ms-6 flex flex-col">
        {files.data.files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 text-left font-mono text-xs hover:bg-accent/50"
              aria-label={`Open diff of ${file.path}`}
              onClick={() => onOpenCommitFile(sha, file)}
            >
              <span className="w-3 shrink-0 text-muted-foreground">
                {COMMIT_FILE_STATUS_LETTER[file.status]}
              </span>
              <StartTruncatedPath path={file.path} className="flex-1" />
            </button>
          </li>
        ))}
      </ul>
      {files.data.truncated ? (
        <p className="ms-6 px-1.5 py-1 text-muted-foreground text-xs">Showing the first files.</p>
      ) : null}
    </>
  );
}

function CommitRow({
  threadRef,
  cwd,
  commit,
  onOpenCommitFile,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly commit: VcsCommit;
  readonly onOpenCommitFile: OpenCommitFile;
}) {
  const expanded = useSourceControlCommitsStore((state) =>
    readSourceControlCommitsUi(state.byThreadKey, threadRef).expandedShas.includes(commit.sha),
  );
  const refs = orderCommitRefs(commit.refs);
  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-start gap-1 rounded-md px-0.5 py-1 text-left hover:bg-accent/50"
        onClick={() =>
          useSourceControlCommitsStore.getState().toggleExpanded(threadRef, commit.sha)
        }
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-90")}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-sm">{commit.subject}</span>
            {refs.length > 0 ? (
              <span className="flex shrink-0 gap-1">
                {refs.slice(0, VISIBLE_REFS).map((ref) => (
                  <Badge
                    key={`${ref.kind}:${ref.name}`}
                    size="sm"
                    variant={REF_BADGE_VARIANT[ref.kind]}
                  >
                    {ref.name}
                  </Badge>
                ))}
                {refs.length > VISIBLE_REFS ? (
                  <Badge size="sm" variant="outline">
                    +{refs.length - VISIBLE_REFS}
                  </Badge>
                ) : null}
              </span>
            ) : null}
          </span>
          <span className="truncate text-muted-foreground text-xs">
            <span className="font-mono">{commit.shortSha}</span> · {commit.authorName} ·{" "}
            {formatRelativeTimeLabel(commit.authoredAt)}
          </span>
        </span>
      </button>
      {expanded ? (
        <CommitFiles
          environmentId={threadRef.environmentId}
          cwd={cwd}
          sha={commit.sha}
          onOpenCommitFile={onOpenCommitFile}
        />
      ) : null}
    </li>
  );
}

// Each page asks for the next one only on request. The log query refetches when HEAD moves.
function CommitPage({
  threadRef,
  gitCwd,
  cursor,
  pageIndex,
  onOpenCommitFile,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly gitCwd: string;
  readonly cursor: number | undefined;
  readonly pageIndex: number;
  readonly onOpenCommitFile: OpenCommitFile;
}) {
  const showNext = useSourceControlCommitsStore(
    (state) => readSourceControlCommitsUi(state.byThreadKey, threadRef).pages > pageIndex + 1,
  );
  const page = useEnvironmentQuery(
    vcsEnvironment.log({
      environmentId: threadRef.environmentId,
      input: { cwd: gitCwd, ...(cursor === undefined ? {} : { cursor }) },
    }),
  );
  if (page.data === null) {
    return page.error ? (
      <QueryError message={page.error} onRetry={page.refresh} />
    ) : (
      <Spinner aria-label="Loading commits" className="mx-auto my-2 size-4" />
    );
  }
  const { commits, nextCursor } = page.data;
  return (
    <>
      {commits.length === 0 && cursor === undefined ? (
        <p className="px-1.5 py-1 text-muted-foreground text-xs">No commits yet</p>
      ) : (
        <ul className="flex flex-col">
          {commits.map((commit) => (
            <CommitRow
              key={commit.sha}
              threadRef={threadRef}
              cwd={gitCwd}
              commit={commit}
              onOpenCommitFile={onOpenCommitFile}
            />
          ))}
        </ul>
      )}
      {nextCursor === null ? null : showNext ? (
        <CommitPage
          threadRef={threadRef}
          gitCwd={gitCwd}
          cursor={nextCursor}
          pageIndex={pageIndex + 1}
          onOpenCommitFile={onOpenCommitFile}
        />
      ) : (
        <Button
          size="xs"
          variant="ghost"
          className="w-full"
          onClick={() => useSourceControlCommitsStore.getState().setPages(threadRef, pageIndex + 2)}
        >
          Load more
        </Button>
      )}
    </>
  );
}

export function SourceControlCommits({
  threadRef,
  gitCwd,
  onOpenCommitFile,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly gitCwd: string;
  readonly onOpenCommitFile: OpenCommitFile;
}) {
  const expanded = useSourceControlCommitsStore(
    (state) => readSourceControlCommitsUi(state.byThreadKey, threadRef).open,
  );
  return (
    <section aria-label="Commits" className="flex min-h-0 shrink-0 flex-col border-t pt-1">
      <button
        type="button"
        aria-expanded={expanded}
        className="flex cursor-pointer items-center gap-1 rounded-md px-0.5 py-1 text-left font-medium text-muted-foreground text-xs"
        onClick={() => useSourceControlCommitsStore.getState().setOpen(threadRef, !expanded)}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 shrink-0", expanded && "rotate-90")}
        />
        Commits
      </button>
      {expanded ? (
        <ScrollArea className="max-h-72">
          <CommitPage
            threadRef={threadRef}
            gitCwd={gitCwd}
            cursor={undefined}
            pageIndex={0}
            onOpenCommitFile={onOpenCommitFile}
          />
        </ScrollArea>
      ) : null}
    </section>
  );
}
