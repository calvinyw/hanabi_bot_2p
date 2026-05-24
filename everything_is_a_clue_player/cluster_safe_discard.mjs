import {
  createPositionClusterMapping,
} from "./cluster_discard_trash.mjs";

export function createClusterSafeDiscardMapping(
  partnerHandPositions,
  actingPlayerSafeDiscardNotKnownTrashPositions,
  gameState = {},
  options = {},
) {
  return createPositionClusterMapping(
    partnerHandPositions,
    actingPlayerSafeDiscardNotKnownTrashPositions,
    gameState,
    options,
  );
}

export const createClusterSafeDiscardNotKnownTrashMapping =
  createClusterSafeDiscardMapping;
export const clusterSafeDiscard = createClusterSafeDiscardMapping;
export const clusterSafeDiscardNotKnownTrash = createClusterSafeDiscardMapping;
export const cluster_safe_discard = createClusterSafeDiscardMapping;
export const cluster_safe_discard_not_known_trash =
  createClusterSafeDiscardMapping;
