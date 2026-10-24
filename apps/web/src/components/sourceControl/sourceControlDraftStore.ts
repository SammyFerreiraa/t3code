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
  /** Clears the draft unless the message changed since `committedMessage` was sent. */
  clearCommitted: (ref: ScopedThreadRef, committedMessage: string) => void;
}

export const EMPTY_SOURCE_CONTROL_DRAFT: SourceControlDraft = { message: "", excluded: new Set() };

const withoutDraft = (state: SourceControlDraftStoreState, key: string) => {
  if (!(key in state.byThreadKey)) return state;
  const { [key]: _removed, ...byThreadKey } = state.byThreadKey;
  return { byThreadKey };
};

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
  clear: (ref) => set((state) => withoutDraft(state, scopedThreadKey(ref))),
  clearCommitted: (ref, committedMessage) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      return state.byThreadKey[key]?.message.trim() === committedMessage
        ? withoutDraft(state, key)
        : state;
    }),
}));

export const readSourceControlDraft = (ref: ScopedThreadRef): SourceControlDraft =>
  useSourceControlDraftStore.getState().byThreadKey[scopedThreadKey(ref)] ??
  EMPTY_SOURCE_CONTROL_DRAFT;
