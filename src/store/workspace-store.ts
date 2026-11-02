"use client";

import { create } from "zustand";

type Selection =
  { kind: "image"; id: string } | { kind: "edge"; id: string } | null;

type WorkspaceState = {
  selection: Selection;
  inspectorOpen: boolean;
  exploreOpen: boolean;
  setSelection: (selection: Selection) => void;
  clearSelection: () => void;
  closeInspector: () => void;
  openExplore: () => void;
  closeExplore: () => void;
  reset: () => void;
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  selection: null,
  inspectorOpen: false,
  exploreOpen: false,
  setSelection: (selection) =>
    set({ selection, inspectorOpen: selection !== null, exploreOpen: false }),
  clearSelection: () =>
    set({ selection: null, inspectorOpen: false, exploreOpen: false }),
  closeInspector: () => set({ inspectorOpen: false }),
  openExplore: () => set({ exploreOpen: true, inspectorOpen: true }),
  closeExplore: () => set({ exploreOpen: false }),
  reset: () =>
    set({ selection: null, inspectorOpen: false, exploreOpen: false }),
}));
