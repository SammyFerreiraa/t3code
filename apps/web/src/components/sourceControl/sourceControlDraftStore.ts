import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

interface SourceControlDraft {
  readonly message: string;
  readonly excluded: ReadonlySet<string>;
}

interface SourceControlDraftStoreState {
  byThreadKey: Record<string, SourceControlDraft>;
  update: (ref: ScopedThreadRef, patch: Partial<SourceControlDraft>) => void;
  clear: (ref: ScopedThreadRef) => void;
}

export const EMPTY_SOURCE_CONTROL_DRAFT: SourceControlDraft = { message: "", excluded: new Set() };

// Session-only: the Source Control tab unmounts whenever another tab opens, which must not drop a
// half-written commit message or file selection.
export const useSourceControlDraftStore = create<SourceControlDraftStoreState>()((set) => ({
  byThreadKey: {},
  update: (ref, patch) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [key]: { ...(state.byThreadKey[key] ?? EMPTY_SOURCE_CONTROL_DRAFT), ...patch },
        },
      };
    }),
  clear: (ref) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      if (!(key in state.byThreadKey)) return state;
      const { [key]: _removed, ...byThreadKey } = state.byThreadKey;
      return { byThreadKey };
    }),
}));

export const readSourceControlDraft = (ref: ScopedThreadRef): SourceControlDraft =>
  useSourceControlDraftStore.getState().byThreadKey[scopedThreadKey(ref)] ??
  EMPTY_SOURCE_CONTROL_DRAFT;
