const COLORS = ["R", "Y", "G", "B"];
const RANKS = ["1", "2", "3", "4"];
const CLUES = [...COLORS, ...RANKS];
const HAND_SIZE = 4;
const COLOR_DIMENSIONS = COLORS.length;
const RANK_DIMENSIONS = RANKS.length;
const CARD_DIMENSIONS = COLOR_DIMENSIONS + RANK_DIMENSIONS + 3;
const PLAYABLE_OFFSET = COLOR_DIMENSIONS + RANK_DIMENSIONS;
const TRASH_OFFSET = PLAYABLE_OFFSET + 1;
const SAVED_OFFSET = TRASH_OFFSET + 1;
const EMBEDDING_DIMENSIONS = HAND_SIZE * CARD_DIMENSIONS;
const MAX_K_MEANS_ITERATIONS = 10;
const HIGHEST_RANK = 4;
const PLAYABLE_WEIGHT = 8;
const TRASH_WEIGHT = 8;
const SAVED_WEIGHT = 3;
const MAX_REBALANCE_PASSES = 5;
const ALL_SUBSET_MASKS = Array.from({ length: 15 }, (_, index) => index + 1);

const COLOR_INDEXES = Object.fromEntries(
  COLORS.map((color, index) => [color, index]),
);
const RANK_INDEXES = Object.fromEntries(
  RANKS.map((rank, index) => [rank, index]),
);
const CARD_IDENTITIES = COLORS.flatMap((color) =>
  RANKS.map((rank) => `${color}${rank}`),
);
const TOTAL_CARD_COPIES = Object.fromEntries(
  CARD_IDENTITIES.map((card) => [card, getTotalCardCopies(card)]),
);
const CLUSTERS = buildClusters();
const CLUSTER_INDEX_BY_KEY = new Map(
  CLUSTERS.map((cluster, index) => [createClueAction(cluster.clue, cluster.mask), index]),
);

export const CLUE_LABELS = {
  R: "Red",
  Y: "Yellow",
  G: "Green",
  B: "Blue",
  1: "One",
  2: "Two",
  3: "Three",
  4: "Four",
};

export function createClusterClueMapping(globalPossibleHands, gameState) {
  const featureContext = createFeatureContext(gameState);
  const possibleHandPoints = Object.keys(globalPossibleHands)
    .filter((handKey) => globalPossibleHands[handKey])
    .map((handKey) => createHandPoint(handKey, featureContext));
  const clueToGive = Object.create(null);

  if (possibleHandPoints.length === 0) {
    return clueToGive;
  }

  const assignments = initializeAssignmentsBySmallestLegalCluster(possibleHandPoints);
  const centroids = new Float64Array(CLUSTERS.length * EMBEDDING_DIMENSIONS);
  const centroidNorms = new Float64Array(CLUSTERS.length);
  let clusterCounts = updateCentroids(
    possibleHandPoints,
    assignments,
    centroids,
    centroidNorms,
  );

  for (let iteration = 0; iteration < MAX_K_MEANS_ITERATIONS; iteration++) {
    const changedAssignments = assignHandsToClosestLegalClusters(
      possibleHandPoints,
      centroids,
      centroidNorms,
      assignments,
      clusterCounts,
    );

    if (changedAssignments === 0) {
      break;
    }

    clusterCounts = updateCentroids(
      possibleHandPoints,
      assignments,
      centroids,
      centroidNorms,
    );
  }

  rebalanceAssignments(
    possibleHandPoints,
    assignments,
    centroids,
    centroidNorms,
    clusterCounts,
  );

  for (const [index, handPoint] of possibleHandPoints.entries()) {
    clueToGive[handPoint.handKey] = CLUSTERS[assignments[index]].action;
  }

  return clueToGive;
}

export const createClueMapping = createClusterClueMapping;

function buildClusters() {
  const clusters = [];

  for (const clue of CLUES) {
    for (const mask of ALL_SUBSET_MASKS) {
      clusters.push({
        clue,
        mask,
        action: createClueAction(clue, mask),
      });
    }
  }

  return clusters;
}

function createFeatureContext(gameState) {
  return {
    discardedCounts: getDiscardedCounts(gameState?.discards ?? []),
    playedStacks: gameState?.playedStacks ?? {},
  };
}

function getDiscardedCounts(discards) {
  const discardedCounts = Object.create(null);

  for (const card of CARD_IDENTITIES) {
    discardedCounts[card] = 0;
  }

  for (const card of discards) {
    discardedCounts[card]++;
  }

  return discardedCounts;
}

function createHandPoint(handKey, featureContext) {
  const cards = handKey.split("|");
  const activeFeatures = getActiveFeatures(cards, featureContext);

  return {
    handKey,
    activeDimensions: Uint8Array.from(
      activeFeatures.map((feature) => feature.dimension),
    ),
    activeValues: Float64Array.from(
      activeFeatures.map((feature) => feature.value),
    ),
    legalClusterIndexes: getLegalClusterIndexes(cards),
    norm: activeFeatures.reduce(
      (total, feature) => total + feature.value * feature.value,
      0,
    ),
  };
}

function getActiveFeatures(cards, featureContext) {
  const activeFeatures = [];

  for (const [cardIndex, card] of cards.entries()) {
    const color = card[0];
    const rank = card[1];
    const dimensionBase = cardIndex * CARD_DIMENSIONS;
    const status = getCardStatus(card, featureContext);

    if (status.trash) {
      activeFeatures.push({
        dimension: dimensionBase + TRASH_OFFSET,
        value: TRASH_WEIGHT,
      });
      continue;
    }

    activeFeatures.push({
      dimension: dimensionBase + COLOR_INDEXES[color],
      value: 1,
    });
    activeFeatures.push({
      dimension: dimensionBase + COLOR_DIMENSIONS + RANK_INDEXES[rank],
      value: 1,
    });

    if (status.playable) {
      activeFeatures.push({
        dimension: dimensionBase + PLAYABLE_OFFSET,
        value: PLAYABLE_WEIGHT,
      });
    }

    if (status.saved) {
      activeFeatures.push({
        dimension: dimensionBase + SAVED_OFFSET,
        value: SAVED_WEIGHT,
      });
    }
  }

  return activeFeatures;
}

function getCardStatus(card, featureContext) {
  const color = card[0];
  const rank = Number.parseInt(card[1] ?? "0", 10);
  const playedRank = featureContext.playedStacks[color] ?? 0;
  const playable = rank === playedRank + 1;
  const trash = rank <= playedRank;
  const remainingCopies =
    TOTAL_CARD_COPIES[card] - (featureContext.discardedCounts[card] ?? 0);
  const saved = !playable && !trash && remainingCopies === 1;

  return {
    playable,
    trash,
    saved,
  };
}

function getTotalCardCopies(card) {
  const rank = Number.parseInt(card[1] ?? "0", 10);

  if (rank === 1) {
    return 3;
  }

  if (rank === HIGHEST_RANK) {
    return 1;
  }

  return 2;
}

function getLegalClusterIndexes(cards) {
  const legalClusterIndexes = [];

  for (const color of COLORS) {
    const mask = getTouchedMask(cards, color, (card, clue) => card[0] === clue);
    if (mask !== 0) {
      legalClusterIndexes.push(getClusterIndex(color, mask));
    }
  }

  for (const rank of RANKS) {
    const mask = getTouchedMask(cards, rank, (card, clue) => card[1] === clue);
    if (mask !== 0) {
      legalClusterIndexes.push(getClusterIndex(rank, mask));
    }
  }

  return new Int16Array(legalClusterIndexes);
}

function getTouchedMask(cards, clue, predicate) {
  let mask = 0;

  for (const [cardIndex, card] of cards.entries()) {
    if (predicate(card, clue)) {
      mask |= 1 << cardIndex;
    }
  }

  return mask;
}

function getClusterIndex(clue, mask) {
  const clusterIndex = CLUSTER_INDEX_BY_KEY.get(createClueAction(clue, mask));

  if (clusterIndex === undefined) {
    throw new Error(`Missing cluster for clue "${clue}" and mask "${mask}".`);
  }

  return clusterIndex;
}

export function createClueAction(clue, mask) {
  return `${clue}:${mask}`;
}

export function getClueActionClue(clueAction) {
  return parseClueAction(clueAction).clue;
}

export function getClueActionTouchedCardIndexes(clueAction) {
  const { mask } = parseClueAction(clueAction);
  const touchedCardIndexes = [];

  for (let cardIndex = 0; cardIndex < HAND_SIZE; cardIndex++) {
    if ((mask & (1 << cardIndex)) !== 0) {
      touchedCardIndexes.push(cardIndex + 1);
    }
  }

  return touchedCardIndexes;
}

function parseClueAction(clueAction) {
  const [clue, maskText] = clueAction.split(":");
  const mask = Number.parseInt(maskText ?? "", 10);

  if (clue === undefined || !CLUES.includes(clue) || Number.isNaN(mask)) {
    throw new Error(`Invalid clue action: ${clueAction}`);
  }

  return {
    clue,
    mask,
  };
}

function calculateCentroidNorm(centroids, clusterIndex) {
  const centroidBase = clusterIndex * EMBEDDING_DIMENSIONS;
  let norm = 0;

  for (
    let dimension = centroidBase;
    dimension < centroidBase + EMBEDDING_DIMENSIONS;
    dimension++
  ) {
    norm += centroids[dimension] * centroids[dimension];
  }

  return norm;
}

function initializeAssignmentsBySmallestLegalCluster(possibleHandPoints) {
  const assignments = new Int16Array(possibleHandPoints.length);
  const clusterCounts = new Uint32Array(CLUSTERS.length);

  for (const [handIndex, handPoint] of possibleHandPoints.entries()) {
    const clusterIndex = findSmallestLegalCluster(
      handPoint.legalClusterIndexes,
      clusterCounts,
    );

    assignments[handIndex] = clusterIndex;
    clusterCounts[clusterIndex]++;
  }

  return assignments;
}

function findSmallestLegalCluster(legalClusterIndexes, clusterCounts) {
  let smallestClusterIndex = legalClusterIndexes[0];
  let smallestClusterCount = clusterCounts[smallestClusterIndex];

  for (const clusterIndex of legalClusterIndexes) {
    const clusterCount = clusterCounts[clusterIndex];

    if (clusterCount < smallestClusterCount) {
      smallestClusterIndex = clusterIndex;
      smallestClusterCount = clusterCount;
    }
  }

  return smallestClusterIndex;
}

function assignHandsToClosestLegalClusters(
  possibleHandPoints,
  centroids,
  centroidNorms,
  assignments,
  clusterCounts,
) {
  let changedAssignments = 0;

  for (const [handIndex, handPoint] of possibleHandPoints.entries()) {
    const nextAssignment = findClosestLegalCluster(
      handPoint,
      centroids,
      centroidNorms,
      clusterCounts,
    );

    if (assignments[handIndex] !== nextAssignment) {
      assignments[handIndex] = nextAssignment;
      changedAssignments++;
    }
  }

  return changedAssignments;
}

function findClosestLegalCluster(
  handPoint,
  centroids,
  centroidNorms,
  clusterCounts,
) {
  let closestClusterIndex = handPoint.legalClusterIndexes[0];
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const clusterIndex of handPoint.legalClusterIndexes) {
    if (clusterCounts[clusterIndex] === 0) {
      continue;
    }

    const distance = calculateDistanceSquared(
      handPoint,
      centroids,
      centroidNorms,
      clusterIndex,
    );

    if (distance < closestDistance) {
      closestClusterIndex = clusterIndex;
      closestDistance = distance;
    }
  }

  return closestClusterIndex;
}

function rebalanceAssignments(
  possibleHandPoints,
  assignments,
  centroids,
  centroidNorms,
  clusterCounts,
) {
  const targetClusterSize = Math.ceil(possibleHandPoints.length / CLUSTERS.length);

  for (let pass = 0; pass < MAX_REBALANCE_PASSES; pass++) {
    let changedAssignments = 0;

    for (const [handIndex, handPoint] of possibleHandPoints.entries()) {
      const currentClusterIndex = assignments[handIndex];
      if (clusterCounts[currentClusterIndex] <= targetClusterSize) {
        continue;
      }

      const nextClusterIndex = findBestRebalanceCluster(
        handPoint,
        currentClusterIndex,
        centroids,
        centroidNorms,
        clusterCounts,
        targetClusterSize,
      );

      if (nextClusterIndex !== currentClusterIndex) {
        assignments[handIndex] = nextClusterIndex;
        clusterCounts[currentClusterIndex]--;
        clusterCounts[nextClusterIndex]++;
        changedAssignments++;
      }
    }

    if (changedAssignments === 0) {
      break;
    }
  }
}

function findBestRebalanceCluster(
  handPoint,
  currentClusterIndex,
  centroids,
  centroidNorms,
  clusterCounts,
  targetClusterSize,
) {
  let bestClusterIndex = currentClusterIndex;
  let bestClusterCount = clusterCounts[currentClusterIndex];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const clusterIndex of handPoint.legalClusterIndexes) {
    const clusterCount = clusterCounts[clusterIndex];
    if (
      clusterIndex === currentClusterIndex
      || clusterCount >= targetClusterSize
      || clusterCount >= bestClusterCount
    ) {
      continue;
    }

    const distance = calculateDistanceSquared(
      handPoint,
      centroids,
      centroidNorms,
      clusterIndex,
    );

    if (
      clusterCount < bestClusterCount
      || (clusterCount === bestClusterCount && distance < bestDistance)
    ) {
      bestClusterIndex = clusterIndex;
      bestClusterCount = clusterCount;
      bestDistance = distance;
    }
  }

  return bestClusterIndex;
}

function calculateDistanceSquared(handPoint, centroids, centroidNorms, clusterIndex) {
  const centroidBase = clusterIndex * EMBEDDING_DIMENSIONS;
  let activeDimensionDotProduct = 0;

  for (const [index, activeDimension] of handPoint.activeDimensions.entries()) {
    activeDimensionDotProduct +=
      handPoint.activeValues[index] * centroids[centroidBase + activeDimension];
  }

  return handPoint.norm - 2 * activeDimensionDotProduct + centroidNorms[clusterIndex];
}

function updateCentroids(
  possibleHandPoints,
  assignments,
  centroids,
  centroidNorms,
) {
  centroids.fill(0);
  const clusterCounts = new Uint32Array(CLUSTERS.length);

  for (const [handIndex, handPoint] of possibleHandPoints.entries()) {
    const clusterIndex = assignments[handIndex];
    const centroidBase = clusterIndex * EMBEDDING_DIMENSIONS;
    clusterCounts[clusterIndex]++;

    for (const [index, activeDimension] of handPoint.activeDimensions.entries()) {
      centroids[centroidBase + activeDimension] += handPoint.activeValues[index];
    }
  }

  for (let clusterIndex = 0; clusterIndex < CLUSTERS.length; clusterIndex++) {
    const centroidBase = clusterIndex * EMBEDDING_DIMENSIONS;
    const clusterCount = clusterCounts[clusterIndex];

    if (clusterCount !== 0) {
      for (let dimension = 0; dimension < EMBEDDING_DIMENSIONS; dimension++) {
        centroids[centroidBase + dimension] /= clusterCount;
      }
    }

    centroidNorms[clusterIndex] = calculateCentroidNorm(centroids, clusterIndex);
  }

  return clusterCounts;
}
