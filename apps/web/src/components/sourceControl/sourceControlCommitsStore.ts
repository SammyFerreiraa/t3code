import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

interface SourceControlCommitsUi {
  readonly open: boolean;
  readonly expandedShas: ReadonlyArray<string>;
  /** Loaded log pages, so "Load more" survives the tab unmounting. */
  readonly pages: number;
}

interface SourceControlCommitsStoreState {
  byThreadKey: Record<string, SourceControlCommitsUi>;
  setOpen: (ref: ScopedThreadRef, open: boolean) => void;
  toggleExpanded: (ref: ScopedThreadRef, sha: string) => void;
  setPages: (ref: ScopedThreadRef, pages: number) => void;
}

export const EMPTY_SOURCE_CONTROL_COMMITS_UI: SourceControlCommitsUi = {
  open: false,
  expandedShas: [],
  pages: 1,
};

export const readSourceControlCommitsUi = (
  byThreadKey: Record<string, SourceControlCommitsUi>,
  ref: ScopedThreadRef,
) => byThreadKey[scopedThreadKey(ref)] ?? EMPTY_SOURCE_CONTROL_COMMITS_UI;

// Session-only, like the draft store: the Source Control tab unmounts whenever another tab opens.
// Shas of commits that no longer exist are never rendered, so they need no pruning.
export const useSourceControlCommitsStore = create<SourceControlCommitsStoreState>()((set) => {
  const patch = (
    ref: ScopedThreadRef,
    change: (current: SourceControlCommitsUi) => Partial<SourceControlCommitsUi>,
  ) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      const current = state.byThreadKey[key] ?? EMPTY_SOURCE_CONTROL_COMMITS_UI;
      return { byThreadKey: { ...state.byThreadKey, [key]: { ...current, ...change(current) } } };
    });
  return {
    byThreadKey: {},
    setOpen: (ref, open) => patch(ref, () => ({ open })),
    toggleExpanded: (ref, sha) =>
      patch(ref, ({ expandedShas }) => ({
        expandedShas: expandedShas.includes(sha)
          ? expandedShas.filter((value) => value !== sha)
          : [...expandedShas, sha],
      })),
    setPages: (ref, pages) => patch(ref, () => ({ pages })),
  };
});
