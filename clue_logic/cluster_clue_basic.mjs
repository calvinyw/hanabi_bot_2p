import {
  createClusterClueMapping as createDynamicClusterClueMapping,
} from "./cluster_clue_core.mjs";

export {
  CLUE_LABELS,
  createClueAction,
  getClueActionClue,
  getClueActionTouchedCardIndexes,
} from "./cluster_clue_core.mjs";

export function createClusterClueMapping(globalPossibleHands, gameState) {
  return createDynamicClusterClueMapping(globalPossibleHands, gameState, {
    normalLoops: 10,
  });
}

export const createClueMapping = createClusterClueMapping;
