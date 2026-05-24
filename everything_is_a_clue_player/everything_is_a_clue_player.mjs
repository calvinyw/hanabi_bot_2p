import {
  createClusterClueMapping,
} from "../clue_logic/cluster_clue_rebalance_first_times.mjs";
import {
  createClusterDiscardTrashMapping,
} from "./cluster_discard_trash.mjs";
import {
  createClusterSafeDiscardMapping,
} from "./cluster_safe_discard.mjs";

const PROBABILITY_TOLERANCE = 1e-6;
const PROMPT_ATTEMPT_LIMIT = 3;
const PLAY_SLOT_NAMES = [
  "leftmost",
  "second_leftmost",
  "third_leftmost",
  "fourth_leftmost",
  "fifth_leftmost",
  "sixth_leftmost",
];

export function everythingIsACluePlayer(parameters = {}) {
  const {
    partnerGlobalPossibleHands,
    globalPossibleHands = partnerGlobalPossibleHands,
    partnerActualHandKey,
    partnerHand,
    actingPlayerHand,
    actingPlayerHandSize,
    trashPositions = [],
    safeDiscardPositions,
    safeDiscardNotKnownTrashPositions =
      safeDiscardPositions ?? [],
    probabilities,
    gameState = {},
    prompt = getDefaultPrompt(),
    random = Math.random,
  } = parameters;

  if (globalPossibleHands === undefined || globalPossibleHands === null) {
    throw new TypeError("partnerGlobalPossibleHands is required.");
  }

  const actualHandKey = partnerActualHandKey ?? normalizeHandKey(partnerHand);
  if (actualHandKey === undefined) {
    throw new TypeError("partnerActualHandKey or partnerHand is required.");
  }

  const handSize = getActingPlayerHandSize(
    actingPlayerHand,
    actingPlayerHandSize,
    gameState,
  );
  const resolvedProbabilities =
    probabilities ??
    askForEverythingIsAClueProbabilities({
      handSize,
      prompt,
    });
  const actionChoices = createEverythingIsAClueActionChoices(
    handSize,
    resolvedProbabilities,
  );

  validateActionChoices(actionChoices, {
    trashPositions,
    safeDiscardNotKnownTrashPositions,
    clueTokens: gameState?.clueTokens,
  });

  const possibleHandKeys = getTrueHandKeys(globalPossibleHands);

  if (!globalPossibleHands[actualHandKey]) {
    throw new Error("The partner actual hand is not currently possible.");
  }

  const beforeCount = possibleHandKeys.length;
  const actionAssignments = Object.create(null);
  const actualActionChoice = chooseWeightedAction(actionChoices, random);
  actionAssignments[actualHandKey] = actualActionChoice.key;

  for (const handKey of possibleHandKeys) {
    if (handKey === actualHandKey) {
      continue;
    }

    const actionChoice = chooseWeightedAction(actionChoices, random);
    actionAssignments[handKey] = actionChoice.key;

    if (actionChoice.key !== actualActionChoice.key) {
      globalPossibleHands[handKey] = false;
    }
  }

  const afterActionCount = countTrueHands(globalPossibleHands);
  const clusterResult = refineByAssignedAction({
    actionChoice: actualActionChoice,
    actualHandKey,
    gameState,
    globalPossibleHands,
    safeDiscardNotKnownTrashPositions,
    trashPositions,
  });
  const afterCount = countTrueHands(globalPossibleHands);

  return {
    action: clusterResult.action,
    actionAssignments,
    actionChoice: actualActionChoice,
    afterActionCount,
    afterCount,
    beforeCount,
    clusterMapping: clusterResult.clusterMapping,
    clusterValue: clusterResult.clusterValue,
    globalPossibleHands,
    probabilities: resolvedProbabilities,
    remainingHandKeys: getTrueHandKeys(globalPossibleHands),
  };
}

export const createEverythingIsACluePlayerAction = everythingIsACluePlayer;
export const everything_is_a_clue_player = everythingIsACluePlayer;

export function askForEverythingIsAClueProbabilities({
  handSize,
  prompt = getDefaultPrompt(),
} = {}) {
  if (typeof prompt !== "function") {
    throw new TypeError("A prompt function is required when probabilities are omitted.");
  }

  const labels = getProbabilityLabels(handSize);
  let lastError;

  for (let attempt = 0; attempt < PROMPT_ATTEMPT_LIMIT; attempt++) {
    const evenProbability = 1 / labels.length;
    const response = prompt(
      `Enter probabilities that add to 1, comma-separated:\n${labels.join(", ")}`,
      labels.map(() => `${evenProbability}`).join(", "),
    );

    if (response === null) {
      throw new Error("Probability prompt was cancelled.");
    }

    try {
      return parseProbabilityList(response, handSize);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export function createEverythingIsAClueActionChoices(handSize, probabilities) {
  const normalized = normalizeProbabilities(probabilities, handSize);
  const actionChoices = [
    {
      key: "trash_discard",
      kind: "trash_discard",
      probability: normalized.trashDiscard,
    },
    {
      key: "safe_discard_not_known_trash",
      kind: "safe_discard_not_known_trash",
      probability: normalized.safeDiscardNotKnownTrash,
    },
  ];

  for (let slotIndex = 0; slotIndex < handSize; slotIndex++) {
    actionChoices.push({
      key: `play:${slotIndex}`,
      kind: "play",
      probability: normalized.playSlots[slotIndex],
      slotIndex,
    });
  }

  actionChoices.push({
    key: "clue",
    kind: "clue",
    probability: normalized.clue,
  });

  return actionChoices;
}

function refineByAssignedAction({
  actionChoice,
  actualHandKey,
  gameState,
  globalPossibleHands,
  safeDiscardNotKnownTrashPositions,
  trashPositions,
}) {
  if (actionChoice.kind === "trash_discard") {
    const clusterMapping = createClusterDiscardTrashMapping(
      getTrueHandKeys(globalPossibleHands),
      trashPositions,
      gameState,
    );
    const clusterValue = refineGlobalPossibleHandsByCluster(
      globalPossibleHands,
      clusterMapping,
      actualHandKey,
    );

    return {
      action: {
        kind: "discard",
        discardKind: "trash",
        position: clusterValue,
      },
      clusterMapping,
      clusterValue,
    };
  }

  if (actionChoice.kind === "safe_discard_not_known_trash") {
    const clusterMapping = createClusterSafeDiscardMapping(
      getTrueHandKeys(globalPossibleHands),
      safeDiscardNotKnownTrashPositions,
      gameState,
    );
    const clusterValue = refineGlobalPossibleHandsByCluster(
      globalPossibleHands,
      clusterMapping,
      actualHandKey,
    );

    return {
      action: {
        kind: "discard",
        discardKind: "safe_discard_not_known_trash",
        position: clusterValue,
      },
      clusterMapping,
      clusterValue,
    };
  }

  if (actionChoice.kind === "clue") {
    const clusterMapping = createClusterClueMapping(
      globalPossibleHands,
      gameState,
    );
    const clusterValue = refineGlobalPossibleHandsByCluster(
      globalPossibleHands,
      clusterMapping,
      actualHandKey,
    );

    return {
      action: {
        kind: "clue",
        clueAction: clusterValue,
      },
      clusterMapping,
      clusterValue,
    };
  }

  return {
    action: {
      kind: "play",
      position: actionChoice.slotIndex,
      slotIndex: actionChoice.slotIndex,
    },
    clusterMapping: undefined,
    clusterValue: actionChoice.slotIndex,
  };
}

function refineGlobalPossibleHandsByCluster(
  globalPossibleHands,
  clusterMapping,
  actualHandKey,
) {
  const actualCluster = clusterMapping[actualHandKey];

  if (actualCluster === undefined) {
    throw new Error("The actual hand was not assigned to a cluster.");
  }

  for (const handKey of Object.keys(globalPossibleHands)) {
    globalPossibleHands[handKey] =
      globalPossibleHands[handKey] && clusterMapping[handKey] === actualCluster;
  }

  return actualCluster;
}

function chooseWeightedAction(actionChoices, random) {
  const roll = random();
  let cumulativeProbability = 0;

  for (const actionChoice of actionChoices) {
    cumulativeProbability += actionChoice.probability;

    if (roll < cumulativeProbability) {
      return actionChoice;
    }
  }

  return actionChoices[actionChoices.length - 1];
}

function validateActionChoices(
  actionChoices,
  { trashPositions, safeDiscardNotKnownTrashPositions, clueTokens },
) {
  let probabilityTotal = 0;

  for (const actionChoice of actionChoices) {
    if (
      !Number.isFinite(actionChoice.probability) ||
      actionChoice.probability < 0
    ) {
      throw new Error(`Invalid probability for ${actionChoice.key}.`);
    }

    probabilityTotal += actionChoice.probability;
  }

  if (Math.abs(probabilityTotal - 1) > PROBABILITY_TOLERANCE) {
    throw new Error(`Probabilities must add to 1; received ${probabilityTotal}.`);
  }

  const trashChoice = actionChoices.find(
    (actionChoice) => actionChoice.kind === "trash_discard",
  );
  if ((trashChoice?.probability ?? 0) > 0 && trashPositions.length === 0) {
    throw new Error("trash discard probability must be 0 when no trash positions exist.");
  }

  if (hasOverlappingPositions(trashPositions, safeDiscardNotKnownTrashPositions)) {
    throw new Error(
      "safe discard and not known trash positions cannot also be trash positions.",
    );
  }

  const safeDiscardChoice = actionChoices.find(
    (actionChoice) => actionChoice.kind === "safe_discard_not_known_trash",
  );
  if (
    (safeDiscardChoice?.probability ?? 0) > 0 &&
    safeDiscardNotKnownTrashPositions.length === 0
  ) {
    throw new Error(
      "safe discard and not known trash probability must be 0 when no matching positions exist.",
    );
  }

  const clueChoice = actionChoices.find(
    (actionChoice) => actionChoice.kind === "clue",
  );
  if ((clueChoice?.probability ?? 0) > 0 && clueTokens === 0) {
    throw new Error("clue probability must be 0 when no clue tokens exist.");
  }
}

function normalizeProbabilities(probabilities, handSize) {
  if (typeof probabilities === "string") {
    return parseProbabilityList(probabilities, handSize);
  }

  if (Array.isArray(probabilities)) {
    return normalizeProbabilityArray(probabilities, handSize);
  }

  if (probabilities !== null && typeof probabilities === "object") {
    return normalizeProbabilityObject(probabilities, handSize);
  }

  throw new TypeError("probabilities must be an array, object, or string.");
}

function parseProbabilityList(probabilitiesText, handSize) {
  const probabilities = probabilitiesText
    .split(",")
    .map((probability) => Number.parseFloat(probability.trim()));

  return normalizeProbabilityArray(probabilities, handSize);
}

function normalizeProbabilityArray(probabilities, handSize) {
  const expectedLength = handSize + 3;
  const numericProbabilities = probabilities.map((probability) =>
    Number(probability),
  );

  if (numericProbabilities.length !== expectedLength) {
    throw new Error(
      `Expected ${expectedLength} probabilities: trash, safe discard and not known trash, ${handSize} plays, clue.`,
    );
  }

  return {
    clue: numericProbabilities[expectedLength - 1],
    playSlots: numericProbabilities.slice(2, expectedLength - 1),
    safeDiscardNotKnownTrash: numericProbabilities[1],
    trashDiscard: numericProbabilities[0],
  };
}

function normalizeProbabilityObject(probabilities, handSize) {
  const playSlots = Array.isArray(probabilities.plays)
    ? probabilities.plays
    : Array.isArray(probabilities.playSlots)
      ? probabilities.playSlots
      : Array.isArray(probabilities.play_slots)
        ? probabilities.play_slots
        : getPlaySlotProbabilities(probabilities, handSize);

  if (playSlots.length !== handSize) {
    throw new Error(`Expected ${handSize} play-slot probabilities.`);
  }

  return {
    clue: getProbabilityValue(probabilities, ["clue"]),
    playSlots: playSlots.map((probability) => Number(probability)),
    safeDiscardNotKnownTrash: getProbabilityValue(probabilities, [
      "safeDiscardNotKnownTrash",
      "safe_discard_not_known_trash",
      "safeDiscardAndNotKnownTrash",
      "safe_discard_and_not_known_trash",
      "safeDiscard",
      "safe_discard",
      "safe",
    ]),
    trashDiscard: getProbabilityValue(probabilities, [
      "trashDiscard",
      "trash_discard",
      "trash",
    ]),
  };
}

function getPlaySlotProbabilities(probabilities, handSize) {
  return Array.from({ length: handSize }, (_, slotIndex) => {
    const slotName = PLAY_SLOT_NAMES[slotIndex];
    const aliases = [
      `play${slotIndex}`,
      `play_${slotIndex}`,
      `playSlot${slotIndex}`,
      `play_slot_${slotIndex}`,
      ...(slotName === undefined
        ? []
        : [
            `play_${slotName}`,
            `play${toPascalCase(slotName)}`,
          ]),
    ];

    return getProbabilityValue(probabilities, aliases);
  });
}

function getProbabilityValue(probabilities, aliases) {
  for (const alias of aliases) {
    if (probabilities[alias] !== undefined) {
      return Number(probabilities[alias]);
    }
  }

  return 0;
}

function getProbabilityLabels(handSize) {
  const labels = ["trash discard", "safe discard and not known trash"];

  for (let slotIndex = 0; slotIndex < handSize; slotIndex++) {
    labels.push(`play ${PLAY_SLOT_NAMES[slotIndex] ?? `slot ${slotIndex + 1}`}`);
  }

  labels.push("clue");
  return labels;
}

function hasOverlappingPositions(leftPositions, rightPositions) {
  const leftPositionKeys = new Set(leftPositions.map(getPositionKey));

  return rightPositions.some((position) => leftPositionKeys.has(getPositionKey(position)));
}

function getPositionKey(position) {
  if (position === null || typeof position !== "object") {
    return `${typeof position}:${position}`;
  }

  return JSON.stringify(position);
}

function getActingPlayerHandSize(actingPlayerHand, actingPlayerHandSize, gameState) {
  if (Number.isInteger(actingPlayerHandSize)) {
    return actingPlayerHandSize;
  }

  if (Array.isArray(actingPlayerHand)) {
    return actingPlayerHand.length;
  }

  if (Number.isInteger(gameState?.variant?.handSize)) {
    return gameState.variant.handSize;
  }

  return 4;
}

function getTrueHandKeys(globalPossibleHands) {
  return Object.keys(globalPossibleHands).filter(
    (handKey) => globalPossibleHands[handKey],
  );
}

function countTrueHands(globalPossibleHands) {
  let count = 0;

  for (const handKey of Object.keys(globalPossibleHands)) {
    if (globalPossibleHands[handKey]) {
      count++;
    }
  }

  return count;
}

function normalizeHandKey(hand) {
  if (typeof hand === "string") {
    return hand;
  }

  if (Array.isArray(hand)) {
    return hand.join("|");
  }

  return undefined;
}

function toPascalCase(text) {
  return text
    .split("_")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join("");
}

function getDefaultPrompt() {
  return typeof globalThis.prompt === "function"
    ? globalThis.prompt.bind(globalThis)
    : undefined;
}
