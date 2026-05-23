const DEFAULT_COLORS = ["R", "Y", "G", "B"];
const DEFAULT_RANKS = ["1", "2", "3", "4"];
const DEFAULT_HAND_SIZE = 4;
const DEFAULT_NORMAL_LOOPS = 10;

export const CLUE_LABELS = {
  R: "Red",
  Y: "Yellow",
  G: "Green",
  B: "Blue",
  W: "White",
  P: "Purple",
  1: "One",
  2: "Two",
  3: "Three",
  4: "Four",
  5: "Five",
  6: "Six",
};

const CONFIG_CACHE = new Map();

export function createClusterClueMapping(globalPossibleHands, gameState, options = {}) {
  const config = getClusterConfig(gameState?.variant);
  const featureContext = createFeatureContext(gameState, config);
  const possibleHandPoints = Object.keys(globalPossibleHands)
    .filter((handKey) => globalPossibleHands[handKey])
    .map((handKey) => createHandPoint(handKey, featureContext, config));
  const clueToGive = Object.create(null);

  if (possibleHandPoints.length === 0) {
    return clueToGive;
  }

  const assignments = initializeAssignmentsBySmallestLegalCluster(
    possibleHandPoints,
    config,
  );
  const centroids = new Float64Array(
    config.clusters.length * config.embeddingDimensions,
  );
  const centroidNorms = new Float64Array(config.clusters.length);
  let clusterCounts = updateCentroids(
    possibleHandPoints,
    assignments,
    centroids,
    centroidNorms,
    config,
  );

  const rebalanceLoops = options.rebalanceLoops ?? 0;
  const rebalancePassesPerIteration = options.rebalancePassesPerIteration ?? 0;
  for (let iteration = 0; iteration < rebalanceLoops; iteration++) {
    const changedAssignments = assignHandsToClosestLegalClusters(
      possibleHandPoints,
      centroids,
      centroidNorms,
      assignments,
      clusterCounts,
      config,
    );

    clusterCounts = countAssignments(assignments, config);

    const rebalancedAssignments = rebalanceAssignments(
      possibleHandPoints,
      assignments,
      centroids,
      centroidNorms,
      clusterCounts,
      config,
      rebalancePassesPerIteration,
    );

    if (changedAssignments + rebalancedAssignments === 0) {
      break;
    }

    clusterCounts = updateCentroids(
      possibleHandPoints,
      assignments,
      centroids,
      centroidNorms,
      config,
    );
  }

  const normalLoops = options.normalLoops ?? DEFAULT_NORMAL_LOOPS;
  for (let iteration = 0; iteration < normalLoops; iteration++) {
    const changedAssignments = assignHandsToClosestLegalClusters(
      possibleHandPoints,
      centroids,
      centroidNorms,
      assignments,
      clusterCounts,
      config,
    );

    if (changedAssignments === 0) {
      break;
    }

    clusterCounts = updateCentroids(
      possibleHandPoints,
      assignments,
      centroids,
      centroidNorms,
      config,
    );
  }

  if ((options.finalRebalancePasses ?? 0) > 0) {
    rebalanceAssignments(
      possibleHandPoints,
      assignments,
      centroids,
      centroidNorms,
      clusterCounts,
      config,
      options.finalRebalancePasses,
    );
  }

  for (const [index, handPoint] of possibleHandPoints.entries()) {
    clueToGive[handPoint.handKey] = config.clusters[assignments[index]].action;
  }

  return clueToGive;
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

  for (let cardIndex = 0; cardIndex < 31 && (1 << cardIndex) <= mask; cardIndex++) {
    if ((mask & (1 << cardIndex)) !== 0) {
      touchedCardIndexes.push(cardIndex + 1);
    }
  }

  return touchedCardIndexes;
}

function parseClueAction(clueAction) {
  const [clue, maskText] = clueAction.split(":");
  const mask = Number.parseInt(maskText ?? "", 10);

  if (clue === undefined || clue === "" || Number.isNaN(mask)) {
    throw new Error(`Invalid clue action: ${clueAction}`);
  }

  return {
    clue,
    mask,
  };
}

function getClusterConfig(variant) {
  const settings = normalizeVariant(variant);
  const cachedConfig = CONFIG_CACHE.get(settings.key);

  if (cachedConfig !== undefined) {
    return cachedConfig;
  }

  const colorDimensions = settings.colors.length;
  const rankDimensions = settings.ranks.length;
  const cardDimensions = colorDimensions + rankDimensions + 3;
  const playableOffset = colorDimensions + rankDimensions;
  const trashOffset = playableOffset + 1;
  const savedOffset = trashOffset + 1;
  const embeddingDimensions = settings.handSize * cardDimensions;
  const playableWeight = 2;
  const trashWeight = 2;
  const savedWeight = 2;
  const colorIndexes = Object.fromEntries(
    settings.colors.map((color, index) => [color, index]),
  );
  const rankIndexes = Object.fromEntries(
    settings.ranks.map((rank, index) => [rank, index]),
  );
  const cardIdentities = settings.colors.flatMap((color) =>
    settings.ranks.map((rank) => `${color}${rank}`),
  );
  const totalCardCopies = Object.fromEntries(
    cardIdentities.map((card) => [
      card,
      getTotalCardCopies(card, settings.highestRank),
    ]),
  );
  const allSubsetMasks = Array.from(
    { length: (1 << settings.handSize) - 1 },
    (_, index) => index + 1,
  );
  const clusters = buildClusters(settings.clues, allSubsetMasks);
  const clusterIndexByKey = new Map(
    clusters.map((cluster, index) => [cluster.action, index]),
  );
  const config = {
    ...settings,
    allSubsetMasks,
    cardDimensions,
    cardIdentities,
    clusterIndexByKey,
    clusters,
    colorDimensions,
    colorIndexes,
    embeddingDimensions,
    playableOffset,
    playableWeight,
    rankDimensions,
    rankIndexes,
    savedOffset,
    savedWeight,
    totalCardCopies,
    trashOffset,
    trashWeight,
  };

  CONFIG_CACHE.set(settings.key, config);
  return config;
}

function normalizeVariant(variant = {}) {
  const colors =
    Array.isArray(variant.colors) && variant.colors.length > 0
      ? variant.colors.map(String)
      : DEFAULT_COLORS;
  const ranks =
    Array.isArray(variant.ranks) && variant.ranks.length > 0
      ? variant.ranks.map(String)
      : DEFAULT_RANKS;
  const handSize = Number.isInteger(variant.handSize)
    ? variant.handSize
    : DEFAULT_HAND_SIZE;
  const highestRank = Number.parseInt(
    variant.highestRank ?? ranks.at(-1) ?? `${DEFAULT_RANKS.length}`,
    10,
  );
  const clues = [...colors, ...ranks];

  return {
    colors,
    ranks,
    handSize,
    highestRank,
    clues,
    key: `${colors.join(",")}|${ranks.join(",")}|${handSize}`,
  };
}

function buildClusters(clues, allSubsetMasks) {
  const clusters = [];

  for (const clue of clues) {
    for (const mask of allSubsetMasks) {
      clusters.push({
        clue,
        mask,
        action: createClueAction(clue, mask),
      });
    }
  }

  return clusters;
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
    handKey,
    activeDimensions: Uint16Array.from(
      activeFeatures.map((feature) => feature.dimension),
    ),
    activeValues: Float64Array.from(
      activeFeatures.map((feature) => feature.value),
    ),
    legalClusterIndexes: getLegalClusterIndexes(cards, config),
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
      dimension: dimensionBase + config.colorIndexes[color],
      value: 1,
    });
    activeFeatures.push({
      dimension: dimensionBase + config.colorDimensions + config.rankIndexes[rank],
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
    config.totalCardCopies[card] - (featureContext.discardedCounts[card] ?? 0);
  const saved = !playable && !trash && remainingCopies === 1;

  return {
    playable,
    trash,
    saved,
  };
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

function getLegalClusterIndexes(cards, config) {
  const legalClusterIndexes = [];

  for (const color of config.colors) {
    const mask = getTouchedMask(cards, color, (card, clue) => getCardColor(card) === clue);
    if (mask !== 0) {
      legalClusterIndexes.push(getClusterIndex(color, mask, config));
    }
  }

  for (const rank of config.ranks) {
    const mask = getTouchedMask(cards, rank, (card, clue) => getCardRank(card) === clue);
    if (mask !== 0) {
      legalClusterIndexes.push(getClusterIndex(rank, mask, config));
    }
  }

  return Int16Array.from(legalClusterIndexes);
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

function getClusterIndex(clue, mask, config) {
  const clusterIndex = config.clusterIndexByKey.get(createClueAction(clue, mask));

  if (clusterIndex === undefined) {
    throw new Error(`Missing cluster for clue "${clue}" and mask "${mask}".`);
  }

  return clusterIndex;
}

function calculateCentroidNorm(centroids, clusterIndex, config) {
  const centroidBase = clusterIndex * config.embeddingDimensions;
  let norm = 0;

  for (
    let dimension = centroidBase;
    dimension < centroidBase + config.embeddingDimensions;
    dimension++
  ) {
    norm += centroids[dimension] * centroids[dimension];
  }

  return norm;
}

function initializeAssignmentsBySmallestLegalCluster(possibleHandPoints, config) {
  const assignments = new Int16Array(possibleHandPoints.length);
  const clusterCounts = new Uint32Array(config.clusters.length);

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
  config,
) {
  let changedAssignments = 0;

  for (const [handIndex, handPoint] of possibleHandPoints.entries()) {
    const nextAssignment = findClosestLegalCluster(
      handPoint,
      centroids,
      centroidNorms,
      clusterCounts,
      config,
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
  config,
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
      config,
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
  config,
  maxPasses,
) {
  const targetClusterSize = Math.ceil(possibleHandPoints.length / config.clusters.length);
  let totalChangedAssignments = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
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
        config,
        targetClusterSize,
      );

      if (nextClusterIndex !== currentClusterIndex) {
        assignments[handIndex] = nextClusterIndex;
        clusterCounts[currentClusterIndex]--;
        clusterCounts[nextClusterIndex]++;
        changedAssignments++;
        totalChangedAssignments++;
      }
    }

    if (changedAssignments === 0) {
      break;
    }
  }

  return totalChangedAssignments;
}

function findBestRebalanceCluster(
  handPoint,
  currentClusterIndex,
  centroids,
  centroidNorms,
  clusterCounts,
  config,
  targetClusterSize,
) {
  let bestClusterIndex = currentClusterIndex;
  let bestClusterCount = clusterCounts[currentClusterIndex];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const clusterIndex of handPoint.legalClusterIndexes) {
    const clusterCount = clusterCounts[clusterIndex];
    if (
      clusterIndex === currentClusterIndex ||
      clusterCount >= targetClusterSize ||
      clusterCount >= bestClusterCount
    ) {
      continue;
    }

    const distance = calculateDistanceSquared(
      handPoint,
      centroids,
      centroidNorms,
      clusterIndex,
      config,
    );

    if (
      clusterCount < bestClusterCount ||
      (clusterCount === bestClusterCount && distance < bestDistance)
    ) {
      bestClusterIndex = clusterIndex;
      bestClusterCount = clusterCount;
      bestDistance = distance;
    }
  }

  return bestClusterIndex;
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
  possibleHandPoints,
  assignments,
  centroids,
  centroidNorms,
  config,
) {
  centroids.fill(0);
  const clusterCounts = countAssignments(assignments, config);

  for (const [handIndex, handPoint] of possibleHandPoints.entries()) {
    const clusterIndex = assignments[handIndex];
    const centroidBase = clusterIndex * config.embeddingDimensions;

    for (const [index, activeDimension] of handPoint.activeDimensions.entries()) {
      centroids[centroidBase + activeDimension] += handPoint.activeValues[index];
    }
  }

  for (let clusterIndex = 0; clusterIndex < config.clusters.length; clusterIndex++) {
    const centroidBase = clusterIndex * config.embeddingDimensions;
    const clusterCount = clusterCounts[clusterIndex];

    if (clusterCount !== 0) {
      for (let dimension = 0; dimension < config.embeddingDimensions; dimension++) {
        centroids[centroidBase + dimension] /= clusterCount;
      }
    }

    centroidNorms[clusterIndex] = calculateCentroidNorm(
      centroids,
      clusterIndex,
      config,
    );
  }

  return clusterCounts;
}

function countAssignments(assignments, config) {
  const clusterCounts = new Uint32Array(config.clusters.length);

  for (const clusterIndex of assignments) {
    clusterCounts[clusterIndex]++;
  }

  return clusterCounts;
}

function getCardColor(card) {
  return card[0];
}

function getCardRank(card) {
  return card.slice(1);
}
