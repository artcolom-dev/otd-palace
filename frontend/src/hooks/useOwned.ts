// The rungs this visitor holds, by pass key (lib/owned), worked out once per change of their passes.
import { useMemo } from "react";
import { useApp } from "../AppContext";
import { useLocal } from "../data/local";
import { type Owned, ownIndex } from "../lib/owned";

export function useOwned(): ReadonlyMap<string, Owned> {
  const { snap } = useApp();
  const { passes } = useLocal();
  return useMemo(() => ownIndex(passes, snap.rules.otd), [passes, snap.rules.otd]);
}
