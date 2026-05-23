const COLORS = ["R", "Y", "G", "B"];
const RANKS = ["1", "2", "3", "4"];
const CLUES = [...COLORS, ...RANKS];
const HAND_SIZE = 4;
const CARD_DIMENSIONS = COLORS.length + RANKS.length;
const EMBEDDING_DIMENSIONS = HAND_SIZE * CARD_DIMENSIONS;
const HAND_ACTIVE_DIMENSIONS = HAND_SIZE * 2;
const MAX_K_MEANS_ITERATIONS = 10;
const ALL_SUBSET_MASKS = Array.from({ length: 15 }, (_, index) => index + 1);

const COLOR_INDEXES = Object.fromEntries(
  COLORS.map((color, index) => [color, index]),
);
const RANK_INDEXES = Object.fromEntries(
  RANKS.map((rank, index) => [rank, index]),
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
  void gameState;

  const possibleHandPoints = Object.keys(globalPossibleHands)
    .filter((handKey) => globalPossibleHands[handKey])
    .map(createHandPoint);
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

function createHandPoint(handKey) {
  const cards = handKey.split("|");

  return {
    handKey,
    activeDimensions: getActiveDimensions(cards),
    legalClusterIndexes: getLegalClusterIndexes(cards),
  };
}

function getActiveDimensions(cards) {
  const activeDimensions = new Uint8Array(HAND_ACTIVE_DIMENSIONS);
  let activeIndex = 0;

  for (const [cardIndex, card] of cards.entries()) {
    const color = card[0];
    const rank = card[1];
    const dimensionBase = cardIndex * CARD_DIMENSIONS;

    activeDimensions[activeIndex] = dimensionBase + COLOR_INDEXES[color];
    activeIndex++;
    activeDimensions[activeIndex] =
      dimensionBase + COLORS.length + RANK_INDEXES[rank];
    activeIndex++;
  }

  return activeDimensions;
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
      handPoint.activeDimensions,
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

function calculateDistanceSquared(activeDimensions, centroids, centroidNorms, clusterIndex) {
  const centroidBase = clusterIndex * EMBEDDING_DIMENSIONS;
  let activeDimensionDotProduct = 0;

  for (const activeDimension of activeDimensions) {
    activeDimensionDotProduct += centroids[centroidBase + activeDimension];
  }

  return (
    HAND_ACTIVE_DIMENSIONS -
    2 * activeDimensionDotProduct +
    centroidNorms[clusterIndex]
  );
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

    for (const activeDimension of handPoint.activeDimensions) {
      centroids[centroidBase + activeDimension]++;
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
