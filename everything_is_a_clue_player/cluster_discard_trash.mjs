const DEFAULT_COLORS = ["R", "Y", "G", "B"];
const DEFAULT_RANKS = ["1", "2", "3", "4"];
const DEFAULT_HAND_SIZE = 4;
const DEFAULT_NORMAL_LOOPS = 10;

export function createClusterDiscardTrashMapping(
  partnerHandPositions,
  actingPlayerTrashPositions,
  gameState = {},
  options = {},
) {
  return createPositionClusterMapping(
    partnerHandPositions,
    actingPlayerTrashPositions,
    gameState,
    options,
  );
}

export const clusterDiscardTrash = createClusterDiscardTrashMapping;
export const cluster_discard_trash = createClusterDiscardTrashMapping;

export function createPositionClusterMapping(
  partnerHandPositions,
  targetPositions,
  gameState = {},
  options = {},
) {
  const handEntries = normalizeHandPositions(partnerHandPositions);
  const clusters = normalizeTargetPositions(targetPositions);
  const assignmentByHand = Object.create(null);

  if (handEntries.length === 0 || clusters.length === 0) {
    return assignmentByHand;
  }

  if (clusters.length === 1) {
    for (const { handKey } of handEntries) {
      assignmentByHand[handKey] = clusters[0];
    }

    return assignmentByHand;
  }

  const config = getClusterConfig(
    gameState?.variant,
    inferHandSize(handEntries),
    handEntries,
    gameState,
  );
  const featureContext = createFeatureContext(gameState, config);
  const handPoints = handEntries.map(({ handKey }) =>
    createHandPoint(handKey, featureContext, config),
  );
  const assignments = initializeAssignmentsBySmallestCluster(
    handPoints.length,
    clusters.length,
  );
  const centroids = new Float64Array(
    clusters.length * config.embeddingDimensions,
  );
  const centroidNorms = new Float64Array(clusters.length);
  let clusterCounts = updateCentroids(
    handPoints,
    assignments,
    centroids,
    centroidNorms,
    clusters.length,
    config,
  );

  const normalLoops = options.normalLoops ?? DEFAULT_NORMAL_LOOPS;
  for (let iteration = 0; iteration < normalLoops; iteration++) {
    const changedAssignments = assignHandsToClosestClusters(
      handPoints,
      centroids,
      centroidNorms,
      assignments,
      clusterCounts,
      clusters.length,
      config,
    );

    if (changedAssignments === 0) {
      break;
    }

    clusterCounts = updateCentroids(
      handPoints,
      assignments,
      centroids,
      centroidNorms,
      clusters.length,
      config,
    );
  }

  for (const [index, { handKey }] of handEntries.entries()) {
    assignmentByHand[handKey] = clusters[assignments[index]];
  }

  return assignmentByHand;
}

function normalizeHandPositions(partnerHandPositions) {
  if (!Array.isArray(partnerHandPositions)) {
    throw new TypeError("partnerHandPositions must be an array.");
  }

  const seenHandKeys = new Set();
  const handEntries = [];

  for (const handPosition of partnerHandPositions) {
    const handKey = getHandKey(handPosition);

    if (typeof handKey !== "string" || handKey.length === 0) {
      throw new TypeError("Each partner hand position must contain a hand key.");
    }

    if (!seenHandKeys.has(handKey)) {
      seenHandKeys.add(handKey);
      handEntries.push({
        handKey,
        source: handPosition,
      });
    }
  }

  return handEntries;
}

function getHandKey(handPosition) {
  if (typeof handPosition === "string") {
    return handPosition;
  }

  if (Array.isArray(handPosition)) {
    return handPosition.join("|");
  }

  if (handPosition !== null && typeof handPosition === "object") {
    if (typeof handPosition.handKey === "string") {
      return handPosition.handKey;
    }

    if (typeof handPosition.key === "string") {
      return handPosition.key;
    }

    if (Array.isArray(handPosition.hand)) {
      return handPosition.hand.join("|");
    }

    if (Array.isArray(handPosition.cards)) {
      return handPosition.cards.join("|");
    }
  }

  return undefined;
}

function normalizeTargetPositions(targetPositions) {
  if (!Array.isArray(targetPositions)) {
    throw new TypeError("targetPositions must be an array.");
  }

  const seenPositionKeys = new Set();
  const clusters = [];

  for (const targetPosition of targetPositions) {
    const key = getStablePositionKey(targetPosition);

    if (!seenPositionKeys.has(key)) {
      seenPositionKeys.add(key);
      clusters.push(targetPosition);
    }
  }

  return clusters;
}

function getStablePositionKey(position) {
  if (position === null || typeof position !== "object") {
    return `${typeof position}:${position}`;
  }

  return JSON.stringify(position);
}

function inferHandSize(handEntries) {
  return handEntries[0]?.handKey.split("|").length ?? DEFAULT_HAND_SIZE;
}

function getClusterConfig(variant, inferredHandSize, handEntries, gameState) {
  const inferred = inferColorsAndRanks(handEntries, gameState);
  const colors =
    Array.isArray(variant?.colors) && variant.colors.length > 0
      ? variant.colors.map(String)
      : inferred.colors;
  const ranks =
    Array.isArray(variant?.ranks) && variant.ranks.length > 0
      ? variant.ranks.map(String)
      : inferred.ranks;
  const handSize = Number.isInteger(variant?.handSize)
    ? variant.handSize
    : inferredHandSize;
  const highestRank = Number.parseInt(
    variant?.highestRank ?? ranks.at(-1) ?? `${DEFAULT_RANKS.length}`,
    10,
  );
  const colorDimensions = colors.length;
  const rankDimensions = ranks.length;
  const cardDimensions = colorDimensions + rankDimensions + 3;
  const playableOffset = colorDimensions + rankDimensions;
  const trashOffset = playableOffset + 1;
  const savedOffset = trashOffset + 1;
  const colorIndexes = Object.fromEntries(
    colors.map((color, index) => [color, index]),
  );
  const rankIndexes = Object.fromEntries(
    ranks.map((rank, index) => [rank, index]),
  );
  const cardIdentities = colors.flatMap((color) =>
    ranks.map((rank) => `${color}${rank}`),
  );
  const totalCardCopies = Object.fromEntries(
    cardIdentities.map((card) => [
      card,
      getTotalCardCopies(card, highestRank),
    ]),
  );

  return {
    cardDimensions,
    cardIdentities,
    colorDimensions,
    colorIndexes,
    colors,
    embeddingDimensions: handSize * cardDimensions,
    handSize,
    playableOffset,
    playableWeight: 2,
    rankDimensions,
    rankIndexes,
    ranks,
    savedOffset,
    savedWeight: 2,
    totalCardCopies,
    trashOffset,
    trashWeight: 2,
  };
}

function inferColorsAndRanks(handEntries, gameState) {
  const colors = new Set();
  const ranks = new Set();

  for (const { handKey } of handEntries) {
    for (const card of handKey.split("|")) {
      addCardIdentityParts(card, colors, ranks);
    }
  }

  for (const card of gameState?.discards ?? []) {
    addCardIdentityParts(card, colors, ranks);
  }

  for (const color of Object.keys(gameState?.playedStacks ?? {})) {
    colors.add(color);
  }

  return {
    colors: colors.size === 0 ? DEFAULT_COLORS : [...colors].sort(),
    ranks:
      ranks.size === 0
        ? DEFAULT_RANKS
        : [...ranks].sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10)),
  };
}

function addCardIdentityParts(card, colors, ranks) {
  if (typeof card !== "string" || card.length < 2) {
    return;
  }

  colors.add(getCardColor(card));
  ranks.add(getCardRank(card));
}

function createFeatureContext(gameState, config) {
  return {
    discardedCounts: getDiscardedCounts(gameState?.discards ?? [], config),
    playedStacks: gameState?.playedStacks ?? {},
  };
}

function getDiscardedCounts(discards, config) {
  const discardedCounts = Object.create(null);

  for (const card of config.cardIdentities) {
    discardedCounts[card] = 0;
  }

  for (const card of discards) {
    discardedCounts[card] = (discardedCounts[card] ?? 0) + 1;
  }

  return discardedCounts;
}

function createHandPoint(handKey, featureContext, config) {
  const cards = handKey.split("|");
  const activeFeatures = getActiveFeatures(cards, featureContext, config);

  return {
    activeDimensions: Uint16Array.from(
      activeFeatures.map((feature) => feature.dimension),
    ),
    activeValues: Float64Array.from(
      activeFeatures.map((feature) => feature.value),
    ),
    norm: activeFeatures.reduce(
      (total, feature) => total + feature.value * feature.value,
      0,
    ),
  };
}

function getActiveFeatures(cards, featureContext, config) {
  const activeFeatures = [];

  for (const [cardIndex, card] of cards.entries()) {
    const color = getCardColor(card);
    const rank = getCardRank(card);
    const colorIndex = config.colorIndexes[color];
    const rankIndex = config.rankIndexes[rank];

    if (colorIndex === undefined || rankIndex === undefined) {
      throw new Error(`Card ${card} is not in the clustering variant.`);
    }

    const dimensionBase = cardIndex * config.cardDimensions;
    const status = getCardStatus(card, featureContext, config);

    if (status.trash) {
      activeFeatures.push({
        dimension: dimensionBase + config.trashOffset,
        value: config.trashWeight,
      });
      continue;
    }

    activeFeatures.push({
      dimension: dimensionBase + colorIndex,
      value: 1,
    });
    activeFeatures.push({
      dimension: dimensionBase + config.colorDimensions + rankIndex,
      value: 1,
    });

    if (status.playable) {
      activeFeatures.push({
        dimension: dimensionBase + config.playableOffset,
        value: config.playableWeight,
      });
    }

    if (status.saved) {
      activeFeatures.push({
        dimension: dimensionBase + config.savedOffset,
        value: config.savedWeight,
      });
    }
  }

  return activeFeatures;
}

function getCardStatus(card, featureContext, config) {
  const color = getCardColor(card);
  const rank = Number.parseInt(getCardRank(card), 10);
  const playedRank = featureContext.playedStacks[color] ?? 0;
  const playable = rank === playedRank + 1;
  const trash = rank <= playedRank;
  const remainingCopies =
    (config.totalCardCopies[card] ?? 0) - (featureContext.discardedCounts[card] ?? 0);
  const saved = !playable && !trash && remainingCopies === 1;

  return {
    playable,
    saved,
    trash,
  };
}

function initializeAssignmentsBySmallestCluster(handCount, clusterCount) {
  const assignments = new Int32Array(handCount);
  const clusterCounts = new Uint32Array(clusterCount);

  for (let handIndex = 0; handIndex < handCount; handIndex++) {
    const clusterIndex = findSmallestCluster(clusterCounts);
    assignments[handIndex] = clusterIndex;
    clusterCounts[clusterIndex]++;
  }

  return assignments;
}

function findSmallestCluster(clusterCounts) {
  let smallestClusterIndex = 0;
  let smallestClusterCount = clusterCounts[0];

  for (let clusterIndex = 1; clusterIndex < clusterCounts.length; clusterIndex++) {
    const clusterCount = clusterCounts[clusterIndex];

    if (clusterCount < smallestClusterCount) {
      smallestClusterIndex = clusterIndex;
      smallestClusterCount = clusterCount;
    }
  }

  return smallestClusterIndex;
}

function assignHandsToClosestClusters(
  handPoints,
  centroids,
  centroidNorms,
  assignments,
  clusterCounts,
  clusterCount,
  config,
) {
  let changedAssignments = 0;

  for (const [handIndex, handPoint] of handPoints.entries()) {
    const nextAssignment = findClosestNonemptyCluster(
      handPoint,
      centroids,
      centroidNorms,
      clusterCounts,
      clusterCount,
      config,
    );

    if (assignments[handIndex] !== nextAssignment) {
      assignments[handIndex] = nextAssignment;
      changedAssignments++;
    }
  }

  return changedAssignments;
}

function findClosestNonemptyCluster(
  handPoint,
  centroids,
  centroidNorms,
  clusterCounts,
  clusterCount,
  config,
) {
  let closestClusterIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex++) {
    if (clusterCounts[clusterIndex] === 0) {
      continue;
    }

    const distance = calculateDistanceSquared(
      handPoint,
      centroids,
      centroidNorms,
      clusterIndex,
      config,
    );

    if (distance < closestDistance) {
      closestClusterIndex = clusterIndex;
      closestDistance = distance;
    }
  }

  return closestClusterIndex;
}

function calculateDistanceSquared(handPoint, centroids, centroidNorms, clusterIndex, config) {
  const centroidBase = clusterIndex * config.embeddingDimensions;
  let activeDimensionDotProduct = 0;

  for (const [index, activeDimension] of handPoint.activeDimensions.entries()) {
    activeDimensionDotProduct +=
      handPoint.activeValues[index] * centroids[centroidBase + activeDimension];
  }

  return handPoint.norm - 2 * activeDimensionDotProduct + centroidNorms[clusterIndex];
}

function updateCentroids(
  handPoints,
  assignments,
  centroids,
  centroidNorms,
  clusterCount,
  config,
) {
  centroids.fill(0);
  const clusterCounts = countAssignments(assignments, clusterCount);

  for (const [handIndex, handPoint] of handPoints.entries()) {
    const clusterIndex = assignments[handIndex];
    const centroidBase = clusterIndex * config.embeddingDimensions;

    for (const [index, activeDimension] of handPoint.activeDimensions.entries()) {
      centroids[centroidBase + activeDimension] += handPoint.activeValues[index];
    }
  }

  for (let clusterIndex = 0; clusterIndex < clusterCount; clusterIndex++) {
    const centroidBase = clusterIndex * config.embeddingDimensions;
    const clusterSize = clusterCounts[clusterIndex];

    if (clusterSize !== 0) {
      for (let dimension = 0; dimension < config.embeddingDimensions; dimension++) {
        centroids[centroidBase + dimension] /= clusterSize;
      }
    }

    centroidNorms[clusterIndex] = calculateCentroidNorm(
      centroids,
      centroidBase,
      config.embeddingDimensions,
    );
  }

  return clusterCounts;
}

function calculateCentroidNorm(centroids, centroidBase, embeddingDimensions) {
  let norm = 0;

  for (
    let dimension = centroidBase;
    dimension < centroidBase + embeddingDimensions;
    dimension++
  ) {
    norm += centroids[dimension] * centroids[dimension];
  }

  return norm;
}

function countAssignments(assignments, clusterCount) {
  const clusterCounts = new Uint32Array(clusterCount);

  for (const clusterIndex of assignments) {
    clusterCounts[clusterIndex]++;
  }

  return clusterCounts;
}

function getTotalCardCopies(card, highestRank) {
  const rank = Number.parseInt(getCardRank(card), 10);

  if (rank === 1) {
    return 3;
  }

  if (rank === highestRank) {
    return 1;
  }

  return 2;
}

function getCardColor(card) {
  return card[0];
}

function getCardRank(card) {
  return card.slice(1);
}
