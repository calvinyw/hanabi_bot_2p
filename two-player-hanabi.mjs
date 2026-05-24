import {
  createClueAction,
  createClusterClueMapping,
  getClueActionClue,
  getClueActionTouchedCardIndexes,
} from "./clue_logic/cluster_clue_rebalance_first_times.mjs";
import {
  everythingIsACluePlayer,
} from "./everything_is_a_clue_player/everything_is_a_clue_player.mjs";

const COLOR_DEFINITIONS = [
  ["R", "Red"],
  ["Y", "Yellow"],
  ["G", "Green"],
  ["B", "Blue"],
  ["W", "White"],
  ["P", "Purple"],
];
const RANK_NAMES = {
  1: "One",
  2: "Two",
  3: "Three",
  4: "Four",
  5: "Five",
  6: "Six",
};
const DEFAULT_SETUP = {
  colorCount: 4,
  rankCount: 4,
  handSize: 4,
  strategyMode: "cluster-clue",
};
const STRATEGY_MODES = {
  CLUSTER_CLUE: "cluster-clue",
  EVERYTHING_IS_A_CLUE: "everything-is-a-clue",
};
const STRATEGY_MODE_LABELS = {
  [STRATEGY_MODES.CLUSTER_CLUE]: "Cluster clue",
  [STRATEGY_MODES.EVERYTHING_IS_A_CLUE]: "Everything is a clue",
};
const MAX_CLUE_TOKENS = 8;
const MAX_STRIKES = 3;
const POSSIBILITY_SAMPLE_LIMIT = 60;
const MAX_EXACT_HAND_KEYS = 180_000;
const MAX_SAMPLED_HAND_KEYS = 500_000;

let COLORS = [];
let RANKS = [];
let CLUES = [];
let ALL_CLUSTER_MASKS = [];
let COLOR_NAMES = {};
let CLUE_LABELS = {};
let CARD_IDENTITIES = [];
let HIGHEST_RANK = 0;
let TOTAL_CARD_COPIES = {};
let HAND_SIZE = 0;
let ALL_HAND_KEYS = [];
let usingSampledHandUniverse = false;

const state = {
  setupVisible: true,
  variant: undefined,
  strategyMode: DEFAULT_SETUP.strategyMode,
  everythingProbabilities: [],
  players: [
    createPlayer("Player A"),
    createPlayer("Player B"),
  ],
  currentPlayerIndex: 0,
  deck: [],
  discards: [],
  playedStacks: {
    R: 0,
    Y: 0,
    G: 0,
    B: 0,
  },
  clueTokens: MAX_CLUE_TOKENS,
  strikes: 0,
  turn: 1,
  finalTurnsRemaining: undefined,
  finalRoundStartedThisAction: false,
  actionSerial: 0,
  strategyCache: undefined,
  clueHistory: [],
  revealAllCards: false,
  revealNoCards: false,
  message: "New game ready.",
  gameOver: false,
};

document.addEventListener("DOMContentLoaded", () => {
  configureVariant(DEFAULT_SETUP);
  bindControls();
  showSetupPage();
});

function bindControls() {
  document.addEventListener("click", (event) => {
    const target = event.target;

    if (!(target instanceof HTMLElement)) {
      return;
    }

    const button = target.closest("button[data-action]");
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    const action = button.dataset.action;
    const cardIndexText = button.dataset.cardIndex;
    const cardIndex =
      cardIndexText === undefined ? undefined : Number.parseInt(cardIndexText, 10);

    if (action === "new-game") {
      showSetupPage();
      return;
    }

    if (state.setupVisible) {
      return;
    }

    if (state.gameOver) {
      return;
    }

    if (action === "strategy-action") {
      runStrategyAction();
      return;
    }

    if (cardIndex === undefined || Number.isNaN(cardIndex)) {
      return;
    }

    if (action === "play-card") {
      playCard(cardIndex);
      return;
    }

    if (action === "discard-card") {
      discardCard(cardIndex);
    }
  });

  getElement("reveal-all").addEventListener("change", (event) => {
    const target = event.target;

    if (target instanceof HTMLInputElement) {
      state.revealAllCards = target.checked;
      if (target.checked) {
        state.revealNoCards = false;
        getElement("reveal-none").checked = false;
      }
      render();
    }
  });

  getElement("reveal-none").addEventListener("change", (event) => {
    const target = event.target;

    if (target instanceof HTMLInputElement) {
      state.revealNoCards = target.checked;
      if (target.checked) {
        state.revealAllCards = false;
        getElement("reveal-all").checked = false;
      }
      render();
    }
  });

  getElement("setup-form").addEventListener("submit", (event) => {
    event.preventDefault();

    const setup = readSetupForm();
    if (setup === undefined) {
      return;
    }

    configureVariant(setup);
    state.setupVisible = false;
    startNewGame();
  });

  for (const inputId of ["setup-colors", "setup-ranks", "setup-hand-size"]) {
    getElement(inputId).addEventListener("input", renderSetupSummary);
  }

  document.addEventListener("input", (event) => {
    const target = event.target;

    if (
      target instanceof HTMLInputElement &&
      target.dataset.probabilityIndex !== undefined
    ) {
      const probabilityIndex = Number.parseInt(target.dataset.probabilityIndex, 10);

      if (!Number.isNaN(probabilityIndex)) {
        state.everythingProbabilities[probabilityIndex] = Number.parseFloat(
          target.value,
        );
        renderProbabilityTotal();
      }
    }
  });
}

function showSetupPage() {
  state.setupVisible = true;

  const setup =
    state.variant === undefined
      ? DEFAULT_SETUP
      : {
          ...state.variant,
          strategyMode: state.strategyMode,
        };
  getElement("setup-colors").value = `${setup.colorCount}`;
  getElement("setup-ranks").value = `${setup.rankCount}`;
  getElement("setup-hand-size").value = `${setup.handSize}`;
  setSetupStrategyMode(setup.strategyMode);
  getElement("setup-error").textContent = "";

  renderSetupSummary();
  renderSetupVisibility();
}

function readSetupForm() {
  const colorCount = readSetupNumber("setup-colors", 2, 6);
  const rankCount = readSetupNumber("setup-ranks", 3, 6);
  const handSize = readSetupNumber("setup-hand-size", 3, 6);
  const strategyMode = readSetupStrategyMode();
  const error = getElement("setup-error");

  if (
    colorCount === undefined ||
    rankCount === undefined ||
    handSize === undefined ||
    strategyMode === undefined
  ) {
    error.textContent = "Use C 2-6, R 3-6, and H 3-6.";
    return undefined;
  }

  error.textContent = "";
  return {
    colorCount,
    rankCount,
    handSize,
    strategyMode,
  };
}

function setSetupStrategyMode(strategyMode) {
  const selectedMode = STRATEGY_MODE_LABELS[strategyMode]
    ? strategyMode
    : DEFAULT_SETUP.strategyMode;

  for (const input of document.querySelectorAll("input[name='setup-strategy']")) {
    if (input instanceof HTMLInputElement) {
      input.checked = input.value === selectedMode;
    }
  }
}

function readSetupStrategyMode() {
  const selectedInput = document.querySelector("input[name='setup-strategy']:checked");

  if (
    selectedInput instanceof HTMLInputElement &&
    STRATEGY_MODE_LABELS[selectedInput.value] !== undefined
  ) {
    return selectedInput.value;
  }

  return undefined;
}

function readSetupNumber(id, min, max) {
  const input = getElement(id);
  const value = Number.parseInt(input.value, 10);

  if (Number.isNaN(value) || value < min || value > max) {
    input.setAttribute("aria-invalid", "true");
    return undefined;
  }

  input.removeAttribute("aria-invalid");
  return value;
}

function renderSetupSummary() {
  const setup = {
    colorCount: readPreviewNumber("setup-colors", DEFAULT_SETUP.colorCount),
    rankCount: readPreviewNumber("setup-ranks", DEFAULT_SETUP.rankCount),
    handSize: readPreviewNumber("setup-hand-size", DEFAULT_SETUP.handSize),
  };
  const colorCount = Math.max(2, Math.min(6, setup.colorCount));
  const rankCount = Math.max(3, Math.min(6, setup.rankCount));
  const handSize = Math.max(3, Math.min(6, setup.handSize));
  const cardIdentities = colorCount * rankCount;
  const embeddingDimensions = handSize * (colorCount + rankCount + 3);
  const deckSize = colorCount * (3 + Math.max(0, rankCount - 2) * 2 + 1);
  const estimatedHands = cardIdentities ** handSize;
  const mode =
    estimatedHands > MAX_EXACT_HAND_KEYS
      ? `Sampled hand universe (${MAX_SAMPLED_HAND_KEYS.toLocaleString()} max)`
      : "Exact hand universe";

  getElement("setup-summary").textContent =
    `${deckSize} cards, ${embeddingDimensions} embedding dimensions, ${mode}.`;
}

function readPreviewNumber(id, fallback) {
  const value = Number.parseInt(getElement(id).value, 10);
  return Number.isNaN(value) ? fallback : value;
}

function createDefaultEverythingProbabilities(handSize) {
  return [...Array.from({ length: handSize + 2 }, () => 0), 1];
}

function renderSetupVisibility() {
  getElement("setup-screen").hidden = !state.setupVisible;
  getElement("game-screen").hidden = state.setupVisible;
}

function configureVariant(setup) {
  const colorDefinitions = COLOR_DEFINITIONS.slice(0, setup.colorCount);
  COLORS = colorDefinitions.map(([color]) => color);
  RANKS = Array.from({ length: setup.rankCount }, (_, index) => `${index + 1}`);
  CLUES = [...COLORS, ...RANKS];
  ALL_CLUSTER_MASKS = Array.from(
    { length: (1 << setup.handSize) - 1 },
    (_, index) => index + 1,
  );
  COLOR_NAMES = Object.fromEntries(colorDefinitions);
  CLUE_LABELS = {
    ...Object.fromEntries(colorDefinitions),
    ...Object.fromEntries(RANKS.map((rank) => [rank, RANK_NAMES[rank] ?? rank])),
  };
  CARD_IDENTITIES = COLORS.flatMap((color) =>
    RANKS.map((rank) => `${color}${rank}`),
  );
  HIGHEST_RANK = setup.rankCount;
  TOTAL_CARD_COPIES = Object.fromEntries(
    CARD_IDENTITIES.map((card) => [card, getTotalCardCopies(card)]),
  );
  HAND_SIZE = setup.handSize;
  ALL_HAND_KEYS = [];
  usingSampledHandUniverse = false;
  state.strategyMode = setup.strategyMode ?? DEFAULT_SETUP.strategyMode;
  state.everythingProbabilities = createDefaultEverythingProbabilities(HAND_SIZE);

  state.variant = {
    colorCount: setup.colorCount,
    rankCount: setup.rankCount,
    handSize: setup.handSize,
    colors: [...COLORS],
    ranks: [...RANKS],
    highestRank: HIGHEST_RANK,
  };
}

function startNewGame() {
  state.deck = shuffle(buildDeck());
  state.discards = [];
  state.playedStacks = Object.fromEntries(COLORS.map((color) => [color, 0]));
  state.clueTokens = MAX_CLUE_TOKENS;
  state.strikes = 0;
  state.turn = 1;
  state.finalTurnsRemaining = undefined;
  state.finalRoundStartedThisAction = false;
  state.actionSerial = 0;
  state.strategyCache = undefined;
  state.clueHistory = [];
  state.currentPlayerIndex = 0;
  state.message = "New game ready.";
  state.gameOver = false;

  for (const player of state.players) {
    player.hand = [];
    player.globalPossibleHands = Object.create(null);
    player.possibleVersion = 0;
    player.possibilitySnapshot = {
      count: 0,
      sample: [],
    };
  }

  for (let cardIndex = 0; cardIndex < HAND_SIZE; cardIndex++) {
    for (const player of state.players) {
      const card = drawCard();
      if (card !== undefined) {
        player.hand.push(card);
      }
    }
  }

  ALL_HAND_KEYS = buildPossibleHandUniverse(
    state.players.map((player) => handToKey(player.hand)),
  );

  for (const player of state.players) {
    const actualHandKey = handToKey(player.hand);
    player.globalPossibleHands = createGlobalPossibleHands(true, [actualHandKey]);
    player.possibilitySnapshot = summarizePossibleHands(player.globalPossibleHands);
  }

  render();
}

function createPlayer(name) {
  return {
    name,
    hand: [],
    globalPossibleHands: Object.create(null),
    possibleVersion: 0,
    possibilitySnapshot: {
      count: 0,
      sample: [],
    },
  };
}

function buildDeck() {
  const deck = [];

  for (const color of COLORS) {
    for (let copy = 0; copy < 3; copy++) {
      deck.push(`${color}1`);
    }

    for (let rank = 2; rank < HIGHEST_RANK; rank++) {
      for (let copy = 0; copy < 2; copy++) {
        deck.push(`${color}${rank}`);
      }
    }

    deck.push(`${color}${HIGHEST_RANK}`);
  }

  return deck;
}

function getTotalCardCopies(card) {
  const rank = Number.parseInt(getCardRank(card), 10);

  if (rank === 1) {
    return 3;
  }

  if (rank === HIGHEST_RANK) {
    return 1;
  }

  return 2;
}

function shuffle(cards) {
  const shuffledCards = [...cards];

  for (let index = shuffledCards.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffledCards[index], shuffledCards[swapIndex]] = [
      shuffledCards[swapIndex],
      shuffledCards[index],
    ];
  }

  return shuffledCards;
}

function drawCard() {
  return state.deck.pop();
}

function buildAllHandKeys() {
  const handKeys = [];
  const currentHand = [];

  function appendHands() {
    if (currentHand.length === HAND_SIZE) {
      handKeys.push(handToKey(currentHand));
      return;
    }

    for (const card of CARD_IDENTITIES) {
      currentHand.push(card);
      appendHands();
      currentHand.pop();
    }
  }

  appendHands();
  return handKeys;
}

function buildPossibleHandUniverse(seedHandKeys = []) {
  const estimatedHandKeys = CARD_IDENTITIES.length ** HAND_SIZE;
  usingSampledHandUniverse = estimatedHandKeys > MAX_EXACT_HAND_KEYS;

  if (!usingSampledHandUniverse) {
    return buildAllHandKeys();
  }

  const handKeys = new Set();
  const unavailableCounts = getVisibleUnavailableCardCounts();

  for (const handKey of seedHandKeys) {
    if (isHandPossibleWithVisibleCopies(handKey, unavailableCounts)) {
      handKeys.add(handKey);
    }
  }

  const maxAttempts = MAX_SAMPLED_HAND_KEYS * 30;
  let attempts = 0;

  while (handKeys.size < MAX_SAMPLED_HAND_KEYS && attempts < maxAttempts) {
    attempts++;
    const handKey = createRandomHandKey();

    if (isHandPossibleWithVisibleCopies(handKey, unavailableCounts)) {
      handKeys.add(handKey);
    }
  }

  return [...handKeys];
}

function createRandomHandKey() {
  const availableCards = buildDeck();
  const hand = [];

  for (let cardIndex = 0; cardIndex < HAND_SIZE; cardIndex++) {
    const availableIndex = Math.floor(Math.random() * availableCards.length);
    const [card] = availableCards.splice(availableIndex, 1);
    hand.push(card);
  }

  return handToKey(hand);
}

function createGlobalPossibleHands(initialValue, seedHandKeys = []) {
  const globalPossibleHands = Object.create(null);
  const unavailableCounts = getVisibleUnavailableCardCounts();

  for (const handKey of ALL_HAND_KEYS) {
    globalPossibleHands[handKey] =
      initialValue && isHandPossibleWithVisibleCopies(handKey, unavailableCounts);
  }

  for (const handKey of seedHandKeys) {
    if (initialValue && isHandPossibleWithVisibleCopies(handKey, unavailableCounts)) {
      globalPossibleHands[handKey] = true;
    }
  }

  return globalPossibleHands;
}

function summarizePossibleHands(globalPossibleHands) {
  let count = 0;
  const sample = [];

  for (const handKey of getKnownHandKeys(globalPossibleHands)) {
    if (globalPossibleHands[handKey]) {
      count++;

      if (sample.length < POSSIBILITY_SAMPLE_LIMIT) {
        sample.push(handKey);
      }
    }
  }

  return {
    count,
    sample,
  };
}

function getKnownHandKeys(globalPossibleHands) {
  return Object.keys(globalPossibleHands);
}

function runStrategyAction() {
  if (isEverythingIsAClueMode()) {
    runEverythingIsAClueAction();
    return;
  }

  giveStrategyClue();
}

function runEverythingIsAClueAction() {
  const targetPlayerIndex = getPartnerIndex(state.currentPlayerIndex);
  const targetPlayer = state.players[targetPlayerIndex];
  const actionPositions = getEverythingActionPositions(currentPlayer());
  let probabilities;

  try {
    probabilities = readEverythingProbabilities();
  } catch (error) {
    state.message = error.message;
    render();
    return;
  }

  let result;
  try {
    result = everythingIsACluePlayer({
      partnerGlobalPossibleHands: targetPlayer.globalPossibleHands,
      partnerActualHandKey: handToKey(targetPlayer.hand),
      actingPlayerHand: currentPlayer().hand,
      trashPositions: actionPositions.trashPositions,
      safeDiscardNotKnownTrashPositions:
        actionPositions.safeDiscardNotKnownTrashPositions,
      probabilities,
      gameState: getStrategyGameState(targetPlayerIndex),
    });
  } catch (error) {
    state.message = error.message;
    render();
    return;
  }

  refreshPlayerPossibilitySnapshot(targetPlayer);
  recordEverythingAction(result, targetPlayer);

  const signalSummary = formatEverythingSignalSummary(result, targetPlayer);

  if (result.action.kind === "play") {
    playCard(result.action.slotIndex, { signalSummary });
    return;
  }

  if (result.action.kind === "discard") {
    discardCard(result.action.position, { signalSummary });
    return;
  }

  state.clueTokens--;
  state.message = `${currentPlayer().name} gave ${targetPlayer.name} ${formatClueAction(
    result.action.clueAction,
  )}. ${signalSummary}`;
  finishAction();
}

function giveStrategyClue() {
  if (state.clueTokens <= 0) {
    state.message = "No clue tokens available.";
    render();
    return;
  }

  const targetPlayerIndex = getPartnerIndex(state.currentPlayerIndex);
  const targetPlayer = state.players[targetPlayerIndex];
  const strategy = getCurrentStrategy();
  const actualHandKey = handToKey(targetPlayer.hand);
  const clueAction = strategy.clueToGive[actualHandKey];

  if (clueAction === undefined) {
    state.message = `The strategy can only clue a ${HAND_SIZE}-card hand.`;
    render();
    return;
  }

  applyClue(targetPlayerIndex, strategy.clueToGive, clueAction);

  state.clueTokens--;
  state.message = `${currentPlayer().name} gave ${targetPlayer.name} ${formatClueAction(
    clueAction,
  )}.`;
  state.clueHistory.unshift({
    type: "clue",
    giver: currentPlayer().name,
    receiver: targetPlayer.name,
    clueAction,
    clue: getClueActionClue(clueAction),
    touchedCardIndexes: getClueActionTouchedCardIndexes(clueAction),
    turn: state.turn,
    remainingHands: targetPlayer.possibilitySnapshot.count,
  });
  finishAction();
}

function applyClue(playerIndex, clueToGive, clueAction) {
  const player = state.players[playerIndex];
  const unavailableCounts = getVisibleUnavailableCardCounts();
  const nextSnapshot = {
    count: 0,
    sample: [],
  };

  for (const handKey of getKnownHandKeys(player.globalPossibleHands)) {
    const stillPossible =
      player.globalPossibleHands[handKey] &&
      clueToGive[handKey] === clueAction &&
      isHandPossibleWithVisibleCopies(handKey, unavailableCounts);
    player.globalPossibleHands[handKey] = stillPossible;

    if (stillPossible) {
      nextSnapshot.count++;

      if (nextSnapshot.sample.length < POSSIBILITY_SAMPLE_LIMIT) {
        nextSnapshot.sample.push(handKey);
      }
    }
  }

  player.possibleVersion++;
  player.possibilitySnapshot = nextSnapshot;
}

function getEverythingActionPositions(player) {
  const knownCardStatuses = getKnownCardStatuses(player);
  const safeDiscardNotKnownTrashStatuses =
    getSafeDiscardNotKnownTrashStatuses(player, knownCardStatuses);

  return {
    trashPositions: knownCardStatuses
      .map((status, cardIndex) => (status.trash ? cardIndex : undefined))
      .filter((cardIndex) => cardIndex !== undefined),
    safeDiscardNotKnownTrashPositions: safeDiscardNotKnownTrashStatuses
      .map((isSafeDiscardNotKnownTrash, cardIndex) =>
        isSafeDiscardNotKnownTrash ? cardIndex : undefined,
      )
      .filter((cardIndex) => cardIndex !== undefined),
  };
}

function getSafeDiscardNotKnownTrashStatuses(player, knownCardStatuses) {
  return getSafeDiscardStatuses(player).map(
    (isSafeDiscard, cardIndex) =>
      isSafeDiscard && !knownCardStatuses[cardIndex]?.trash,
  );
}

function getSafeDiscardStatuses(player) {
  const hasSavedPossibility = Array.from(
    { length: player.hand.length },
    () => false,
  );
  const discardedCounts = getDiscardedCardCounts();
  let possibleHandCount = 0;

  for (const handKey of getKnownHandKeys(player.globalPossibleHands)) {
    if (!player.globalPossibleHands[handKey]) {
      continue;
    }

    possibleHandCount++;

    for (const [cardIndex, card] of handKey.split("|").entries()) {
      if (cardIndex >= hasSavedPossibility.length) {
        continue;
      }

      hasSavedPossibility[cardIndex] ||= getCardStatus(
        card,
        discardedCounts,
      ).saved;
    }
  }

  if (possibleHandCount === 0) {
    return hasSavedPossibility.map(() => false);
  }

  return hasSavedPossibility.map((savedPossible) => !savedPossible);
}

function readEverythingProbabilities() {
  const probabilityInputs = [
    ...document.querySelectorAll("input[data-probability-index]"),
  ].filter((input) => input instanceof HTMLInputElement);

  if (probabilityInputs.length !== currentPlayer().hand.length + 3) {
    throw new Error("Probability controls are not ready.");
  }

  const probabilities = probabilityInputs.map((input) =>
    Number.parseFloat(input.value),
  );

  if (probabilities.some((probability) => !Number.isFinite(probability))) {
    throw new Error("Use numeric probabilities.");
  }

  return probabilities;
}

function refreshPlayerPossibilitySnapshot(player) {
  player.possibleVersion++;
  player.possibilitySnapshot = summarizePossibleHands(player.globalPossibleHands);
}

function recordEverythingAction(result, targetPlayer) {
  state.clueHistory.unshift({
    type: "everything",
    giver: currentPlayer().name,
    receiver: targetPlayer.name,
    actionText: formatEverythingAction(result.action),
    turn: state.turn,
    remainingHands: targetPlayer.possibilitySnapshot.count,
  });
}

function formatEverythingSignalSummary(result, targetPlayer) {
  return `Signal: ${formatEverythingAction(result.action)}; ${targetPlayer.possibilitySnapshot.count.toLocaleString()} ${targetPlayer.name} hands remain.`;
}

function formatEverythingAction(action) {
  if (action.kind === "play") {
    return `play Card ${action.slotIndex + 1}`;
  }

  if (action.kind === "discard") {
    const label =
      action.discardKind === "trash"
        ? "trash discard"
        : "safe discard and not known trash";
    return `${label} Card ${action.position + 1}`;
  }

  return `clue ${formatClueAction(action.clueAction)}`;
}

function playCard(cardIndex, actionContext = undefined) {
  const player = currentPlayer();
  const card = player.hand[cardIndex];

  if (card === undefined) {
    return;
  }

  const color = getCardColor(card);
  const rank = Number.parseInt(getCardRank(card), 10);
  const nextPlayableRank = state.playedStacks[color] + 1;

  if (rank === nextPlayableRank) {
    state.playedStacks[color] = rank;
    state.message = `${player.name} played ${formatCard(card)}.`;

    if (rank === HIGHEST_RANK && state.clueTokens < MAX_CLUE_TOKENS) {
      state.clueTokens++;
    }
  } else {
    state.strikes++;
    state.discards.push(card);
    state.message = `${player.name} misplayed ${formatCard(card)}.`;
  }

  replaceKnownCardAfterAction(state.currentPlayerIndex, cardIndex, card);
  pruneAllPossibleHandsByVisibleCopies();
  checkGameOver();
  appendActionContextMessage(actionContext);
  finishAction();
}

function discardCard(cardIndex, actionContext = undefined) {
  const player = currentPlayer();
  const card = player.hand[cardIndex];

  if (card === undefined) {
    return;
  }

  state.discards.push(card);
  state.clueTokens = Math.min(MAX_CLUE_TOKENS, state.clueTokens + 1);
  state.message = `${player.name} discarded ${formatCard(card)}.`;

  replaceKnownCardAfterAction(state.currentPlayerIndex, cardIndex, card);
  pruneAllPossibleHandsByVisibleCopies();
  appendActionContextMessage(actionContext);
  finishAction();
}

function appendActionContextMessage(actionContext) {
  if (actionContext?.signalSummary !== undefined) {
    state.message += ` ${actionContext.signalSummary}`;
  }
}

function replaceKnownCardAfterAction(playerIndex, cardIndex, revealedCard) {
  const player = state.players[playerIndex];
  const drawnCard = drawCard();

  player.hand.splice(cardIndex, 1);

  if (drawnCard !== undefined) {
    player.hand.push(drawnCard);

    if (state.deck.length === 0 && state.finalTurnsRemaining === undefined) {
      state.finalTurnsRemaining = state.players.length;
      state.finalRoundStartedThisAction = true;
      state.message += " Last card drawn. Each player gets one more turn.";
    }
  }

  updatePossibleHandsAfterKnownCardChange(
    player,
    cardIndex,
    revealedCard,
    drawnCard !== undefined,
  );

  if (drawnCard === undefined && state.finalTurnsRemaining !== undefined) {
    state.message += " No card drawn.";
  }
}

function updatePossibleHandsAfterKnownCardChange(
  player,
  cardIndex,
  revealedCard,
  drewCard,
) {
  if (!drewCard) {
    player.globalPossibleHands = createGlobalPossibleHands(false);
    player.possibleVersion++;
    player.possibilitySnapshot = summarizePossibleHands(player.globalPossibleHands);
    return;
  }

  const nextGlobalPossibleHands = createGlobalPossibleHands(false);
  const unavailableCounts = getVisibleUnavailableCardCounts();
  let nextHandCount = 0;

  for (const handKey of getKnownHandKeys(player.globalPossibleHands)) {
    if (!player.globalPossibleHands[handKey]) {
      continue;
    }

    const cards = handKey.split("|");

    if (cards[cardIndex] !== revealedCard) {
      continue;
    }

    const remainingCards = cards.filter((_, index) => index !== cardIndex);

    for (const possibleDraw of CARD_IDENTITIES) {
      const nextHandKey = [...remainingCards, possibleDraw].join("|");
      nextHandCount += addPossibleHand(
        nextGlobalPossibleHands,
        nextHandKey,
        unavailableCounts,
        nextHandCount,
      );
    }
  }

  const actualHandKey = handToKey(player.hand);
  if (
    player.hand.length === HAND_SIZE &&
    isHandPossibleWithVisibleCopies(actualHandKey, unavailableCounts)
  ) {
    nextGlobalPossibleHands[actualHandKey] = true;
  }

  player.globalPossibleHands = nextGlobalPossibleHands;
  player.possibleVersion++;
  player.possibilitySnapshot = summarizePossibleHands(player.globalPossibleHands);
}

function pruneAllPossibleHandsByVisibleCopies() {
  const unavailableCounts = getVisibleUnavailableCardCounts();

  for (const player of state.players) {
    let changed = false;

    for (const handKey of getKnownHandKeys(player.globalPossibleHands)) {
      if (
        player.globalPossibleHands[handKey] &&
        !isHandPossibleWithVisibleCopies(handKey, unavailableCounts)
      ) {
        player.globalPossibleHands[handKey] = false;
        changed = true;
      }
    }

    if (changed) {
      player.possibleVersion++;
      player.possibilitySnapshot = summarizePossibleHands(player.globalPossibleHands);
    }
  }
}

function getVisibleUnavailableCardCounts() {
  const unavailableCounts = Object.create(null);

  for (const card of CARD_IDENTITIES) {
    unavailableCounts[card] = 0;
  }

  for (const card of state.discards) {
    unavailableCounts[card]++;
  }

  for (const color of COLORS) {
    for (let rank = 1; rank <= state.playedStacks[color]; rank++) {
      unavailableCounts[`${color}${rank}`]++;
    }
  }

  return unavailableCounts;
}

function getDiscardedCardCounts() {
  const discardedCounts = Object.create(null);

  for (const card of CARD_IDENTITIES) {
    discardedCounts[card] = 0;
  }

  for (const card of state.discards) {
    discardedCounts[card]++;
  }

  return discardedCounts;
}

function isHandPossibleWithVisibleCopies(
  handKey,
  unavailableCounts = getVisibleUnavailableCardCounts(),
) {
  const handCounts = Object.create(null);

  for (const card of handKey.split("|")) {
    if (TOTAL_CARD_COPIES[card] === undefined) {
      return false;
    }

    handCounts[card] = (handCounts[card] ?? 0) + 1;

    if (
      handCounts[card] + (unavailableCounts[card] ?? 0) >
      TOTAL_CARD_COPIES[card]
    ) {
      return false;
    }
  }

  return true;
}

function addPossibleHand(
  possibleHands,
  handKey,
  unavailableCounts,
  currentHandCount,
) {
  if (possibleHands[handKey] || !isHandPossibleWithVisibleCopies(handKey, unavailableCounts)) {
    return 0;
  }

  if (
    usingSampledHandUniverse &&
    currentHandCount >= MAX_SAMPLED_HAND_KEYS
  ) {
    return 0;
  }

  possibleHands[handKey] = true;
  return 1;
}

function checkGameOver() {
  if (state.strikes >= MAX_STRIKES) {
    state.gameOver = true;
    state.message = "Three strikes. Game over.";
    return;
  }

  const score = COLORS.reduce(
    (total, color) => total + state.playedStacks[color],
    0,
  );

  if (score === COLORS.length * HIGHEST_RANK) {
    state.gameOver = true;
    state.message = "Perfect score.";
  }
}

function finishAction() {
  state.strategyCache = undefined;
  state.actionSerial++;

  updateFinalRoundAfterAction();

  if (!state.gameOver) {
    state.currentPlayerIndex = getPartnerIndex(state.currentPlayerIndex);
    state.turn++;
  }

  render();
}

function updateFinalRoundAfterAction() {
  if (state.gameOver || state.finalTurnsRemaining === undefined) {
    return;
  }

  if (state.finalRoundStartedThisAction) {
    state.finalRoundStartedThisAction = false;
    return;
  }

  state.finalTurnsRemaining--;

  if (state.finalTurnsRemaining <= 0) {
    state.gameOver = true;
    state.message += " Final turn complete. Game over.";
    return;
  }

  state.message += ` ${state.finalTurnsRemaining} final ${
    state.finalTurnsRemaining === 1 ? "turn" : "turns"
  } remaining.`;
}

function getCurrentStrategy() {
  const targetPlayerIndex = getPartnerIndex(state.currentPlayerIndex);
  const targetPlayer = state.players[targetPlayerIndex];
  const cache = state.strategyCache;

  if (
    cache !== undefined &&
    cache.actionSerial === state.actionSerial &&
    cache.currentPlayerIndex === state.currentPlayerIndex &&
    cache.targetPlayerIndex === targetPlayerIndex &&
    cache.targetPossibleVersion === targetPlayer.possibleVersion
  ) {
    return cache;
  }

  const clueToGive = createClusterClueMapping(
    targetPlayer.globalPossibleHands,
    getStrategyGameState(targetPlayerIndex),
  );

  state.strategyCache = {
    actionSerial: state.actionSerial,
    currentPlayerIndex: state.currentPlayerIndex,
    targetPlayerIndex,
    targetPossibleVersion: targetPlayer.possibleVersion,
    clueToGive,
  };

  return state.strategyCache;
}

function isEverythingIsAClueMode() {
  return state.strategyMode === STRATEGY_MODES.EVERYTHING_IS_A_CLUE;
}

function getStrategyGameState(targetPlayerIndex) {
  return {
    currentPlayerIndex: state.currentPlayerIndex,
    targetPlayerIndex,
    clueTokens: state.clueTokens,
    strikes: state.strikes,
    deckRemaining: state.deck.length,
    playedStacks: { ...state.playedStacks },
    discards: [...state.discards],
    turn: state.turn,
    variant: state.variant,
  };
}

function render() {
  renderSetupVisibility();

  if (state.setupVisible) {
    return;
  }

  const strategy =
    state.gameOver || isEverythingIsAClueMode() ? undefined : getCurrentStrategy();
  const targetPlayerIndex = getPartnerIndex(state.currentPlayerIndex);
  const targetPlayer = state.players[targetPlayerIndex];
  const recommendedClueAction =
    strategy === undefined ? undefined : strategy.clueToGive[handToKey(targetPlayer.hand)];
  const clueHistogram =
    strategy === undefined ? [] : getClueHistogram(strategy.clueToGive, targetPlayer);

  renderScoreboard(recommendedClueAction, targetPlayer.name);
  renderPlayers();
  renderStrategyPanel(recommendedClueAction, targetPlayer, clueHistogram);
  renderHistory();
  renderDiscards();

  getElement("status-message").textContent = state.message;
}

function renderScoreboard(recommendedClueAction, targetName) {
  getElement("turn-label").textContent = `Turn ${state.turn}`;
  getElement("current-player-label").textContent = currentPlayer().name;
  getElement("deck-count").textContent = `${state.deck.length}`;
  getElement("clue-token-count").textContent = `${state.clueTokens}`;
  getElement("strike-count").textContent = `${state.strikes}`;
  getElement("score-count").textContent = `${calculateScore()}`;
  getElement("recommended-summary").textContent = isEverythingIsAClueMode()
    ? STRATEGY_MODE_LABELS[state.strategyMode]
    : recommendedClueAction === undefined
      ? "No clue"
      : `${formatClueAction(recommendedClueAction)} to ${targetName}`;

  const stacks = getElement("stacks");
  stacks.innerHTML = "";

  for (const color of COLORS) {
    const stack = document.createElement("div");
    stack.className = `stack stack-${color}`;
    stack.innerHTML = `
      <span>${COLOR_NAMES[color]}</span>
      <strong>${state.playedStacks[color]}</strong>
    `;
    stacks.append(stack);
  }
}

function renderPlayers() {
  const playersContainer = getElement("players");
  playersContainer.innerHTML = "";

  for (const [playerIndex, player] of state.players.entries()) {
    playersContainer.append(renderPlayer(player, playerIndex));
  }
}

function renderPlayer(player, playerIndex) {
  const isCurrentPlayer = playerIndex === state.currentPlayerIndex;
  const canSeeCards =
    !state.revealNoCards && (!isCurrentPlayer || state.revealAllCards);
  const playerElement = document.createElement("section");
  playerElement.className = `player-panel${isCurrentPlayer ? " current" : ""}`;
  const knownCardStatuses = getKnownCardStatuses(player);
  const possibleCardsByIndex = getPossibleCardsByIndex(player);

  const cards = player.hand
    .map((card, cardIndex) =>
      renderCardHTML(
        card,
        cardIndex,
        canSeeCards,
        isCurrentPlayer,
        knownCardStatuses[cardIndex],
        possibleCardsByIndex[cardIndex] ?? [],
      ),
    )
    .join("");
  const sampleHands = player.possibilitySnapshot.sample
    .map((handKey) => `<li>${renderHandKey(handKey)}</li>`)
    .join("");

  playerElement.innerHTML = `
    <div class="player-heading">
      <div>
        <h2>${player.name}</h2>
        <span>${isCurrentPlayer ? "Acting" : "Partner"}</span>
      </div>
      <strong>${player.possibilitySnapshot.count.toLocaleString()} hands</strong>
    </div>
    <div class="hand-row" style="--hand-size: ${HAND_SIZE}; --hand-size-mobile: ${Math.min(
      HAND_SIZE,
      2,
    )}">${cards}</div>
    <div class="possibilities">
      <div class="possibility-heading">
        <span>Global possible hands</span>
        <span>${player.possibilitySnapshot.sample.length.toLocaleString()} shown</span>
      </div>
      <ol>${sampleHands}</ol>
    </div>
  `;

  return playerElement;
}

function renderCardHTML(
  card,
  cardIndex,
  showIdentity,
  includeActions,
  knownCardStatus,
  possibleCards,
) {
  const color = getCardColor(card);
  const rank = getCardRank(card);
  const knowledgeClasses = [
    knownCardStatus?.playable ? "known-playable" : "",
    knownCardStatus?.saved ? "known-saved" : "",
    knownCardStatus?.playableOrSaved &&
    !knownCardStatus?.playable &&
    !knownCardStatus?.saved
      ? "known-playable-or-saved"
      : "",
  ]
    .filter((className) => className !== "")
    .join(" ");
  const trashMarker = knownCardStatus?.trash
    ? '<span class="trash-marker" aria-label="Known trash">🗑️</span>'
    : "";
  const possibleCardsHTML =
    possibleCards.length === 0
      ? '<span class="no-possibilities">None</span>'
      : possibleCards.map((possibleCard) => renderMiniCard(possibleCard)).join("");
  const possibilityList = `<div class="card-possibility-list">${possibleCardsHTML}</div>`;
  const cardFace = showIdentity
    ? `<div class="card-face card-${color} ${knowledgeClasses}">
        <span>${COLOR_NAMES[color]}</span>
        <strong>${rank}</strong>
        ${possibilityList}
        ${trashMarker}
      </div>`
    : `<div class="card-face card-hidden ${knowledgeClasses}">
        <span>Card ${cardIndex + 1}</span>
        <strong>?</strong>
        ${possibilityList}
        ${trashMarker}
      </div>`;
  const actions = includeActions
    ? `<div class="card-actions">
        <button type="button" data-action="play-card" data-card-index="${cardIndex}">Play</button>
        <button type="button" data-action="discard-card" data-card-index="${cardIndex}">Discard</button>
      </div>`
    : "";

  return `<article class="card-slot">
    ${cardFace}
    ${actions}
  </article>`;
}

function getPossibleCardsByIndex(player) {
  const possibleCardsByIndex = Array.from(
    { length: player.hand.length },
    () => new Set(),
  );

  for (const handKey of getKnownHandKeys(player.globalPossibleHands)) {
    if (!player.globalPossibleHands[handKey]) {
      continue;
    }

    for (const [cardIndex, card] of handKey.split("|").entries()) {
      if (cardIndex >= possibleCardsByIndex.length) {
        continue;
      }

      possibleCardsByIndex[cardIndex].add(card);
    }
  }

  return possibleCardsByIndex.map((possibleCards) =>
    CARD_IDENTITIES.filter((card) => possibleCards.has(card)),
  );
}

function getKnownCardStatuses(player) {
  const knownCardStatuses = Array.from({ length: player.hand.length }, () => ({
    playable: true,
    trash: true,
    saved: true,
    playableOrSaved: true,
  }));
  const discardedCounts = getDiscardedCardCounts();
  let possibleHandCount = 0;

  for (const handKey of getKnownHandKeys(player.globalPossibleHands)) {
    if (!player.globalPossibleHands[handKey]) {
      continue;
    }

    possibleHandCount++;

    for (const [cardIndex, card] of handKey.split("|").entries()) {
      if (cardIndex >= knownCardStatuses.length) {
        continue;
      }

      const cardStatus = getCardStatus(card, discardedCounts);
      knownCardStatuses[cardIndex].playable &&= cardStatus.playable;
      knownCardStatuses[cardIndex].trash &&= cardStatus.trash;
      knownCardStatuses[cardIndex].saved &&= cardStatus.saved;
      knownCardStatuses[cardIndex].playableOrSaved &&=
        cardStatus.playable || cardStatus.saved;
    }
  }

  if (possibleHandCount === 0) {
    return knownCardStatuses.map(() => ({
      playable: false,
      trash: false,
      saved: false,
      playableOrSaved: false,
    }));
  }

  return knownCardStatuses;
}

function getCardStatus(card, discardedCounts = getDiscardedCardCounts()) {
  const color = getCardColor(card);
  const rank = Number.parseInt(getCardRank(card), 10);
  const playedRank = state.playedStacks[color] ?? 0;
  const playable = rank === playedRank + 1;
  const trash = rank <= playedRank;
  const saved =
    !playable && !trash && TOTAL_CARD_COPIES[card] - discardedCounts[card] === 1;

  return {
    playable,
    trash,
    saved,
  };
}

function renderHandKey(handKey) {
  return handKey
    .split("|")
    .map((card) => renderMiniCard(card))
    .join("");
}

function renderMiniCard(card) {
  return `<span class="mini-card mini-${getCardColor(card)}">${card}</span>`;
}

function renderStrategyPanel(recommendedClueAction, targetPlayer, clueHistogram) {
  const probabilityPanel = getElement("everything-probability-panel");
  const histogramPanel = getElement("clue-histogram-panel");
  const clueButton = getElement("give-clue-button");

  getElement("strategy-target").textContent = targetPlayer.name;
  getElement("strategy-title").textContent = isEverythingIsAClueMode()
    ? "Everything is a clue"
    : "Strategy clue";
  getElement("strategy-clue-label").textContent = isEverythingIsAClueMode()
    ? "Next action"
    : "Clue to give";
  getElement("strategy-clue").textContent =
    isEverythingIsAClueMode()
      ? STRATEGY_MODE_LABELS[state.strategyMode]
      : formatRecommendedClue(recommendedClueAction);
  getElement("strategy-actual-hand").innerHTML = renderHandKey(
    handToKey(targetPlayer.hand),
  );

  probabilityPanel.hidden = !isEverythingIsAClueMode();
  histogramPanel.hidden = isEverythingIsAClueMode();

  if (isEverythingIsAClueMode()) {
    renderEverythingProbabilityControls();
    clueButton.textContent = "Run action";
    clueButton.toggleAttribute("disabled", state.gameOver);
  } else {
    clueButton.textContent = formatClueButtonLabel(recommendedClueAction);
    clueButton.toggleAttribute(
      "disabled",
      recommendedClueAction === undefined || state.clueTokens === 0 || state.gameOver,
    );
  }

  renderClueHistogram(clueHistogram);
}

function formatRecommendedClue(recommendedClueAction) {
  return recommendedClueAction === undefined
    ? "No clue"
    : formatClueAction(recommendedClueAction);
}

function formatClueButtonLabel(recommendedClueAction) {
  return recommendedClueAction === undefined
    ? "Give clue"
    : `Give ${formatClue(getClueActionClue(recommendedClueAction))}`;
}

function renderEverythingProbabilityControls() {
  const handSize = currentPlayer().hand.length;
  const probabilityGrid = getElement("everything-probability-grid");

  if (state.everythingProbabilities.length !== handSize + 3) {
    state.everythingProbabilities = createDefaultEverythingProbabilities(handSize);
  }

  probabilityGrid.innerHTML = "";

  for (const [index, label] of getEverythingProbabilityLabels(handSize).entries()) {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "1";
    input.step = "0.01";
    input.value = `${state.everythingProbabilities[index] ?? 0}`;
    input.dataset.probabilityIndex = `${index}`;

    const field = document.createElement("label");
    field.className = "probability-field";
    field.innerHTML = `<span>${label}</span>`;
    field.append(input);
    probabilityGrid.append(field);
  }

  renderEverythingSlotSummary();
  renderProbabilityTotal();
}

function getEverythingProbabilityLabels(handSize) {
  return [
    "Trash",
    "Safe discard and not known trash",
    ...Array.from({ length: handSize }, (_, cardIndex) => `Play ${cardIndex + 1}`),
    "Clue",
  ];
}

function renderEverythingSlotSummary() {
  const actionPositions = getEverythingActionPositions(currentPlayer());

  getElement("everything-slot-summary").textContent =
    `Trash ${formatSlotList(
      actionPositions.trashPositions,
    )} · Safe discard and not known trash ${formatSlotList(
      actionPositions.safeDiscardNotKnownTrashPositions,
    )}`;
}

function renderProbabilityTotal() {
  const total = state.everythingProbabilities.reduce(
    (sum, probability) => sum + (Number.isFinite(probability) ? probability : 0),
    0,
  );
  const totalElement = getElement("everything-probability-total");

  totalElement.textContent = `Total ${total.toFixed(3)}`;
  totalElement.toggleAttribute("aria-invalid", Math.abs(total - 1) > 1e-6);
}

function formatSlotList(cardIndexes) {
  if (cardIndexes.length === 0) {
    return "none";
  }

  return cardIndexes.map((cardIndex) => cardIndex + 1).join(", ");
}

function getClueHistogram(clueToGive, targetPlayer) {
  const clueCounts = Object.fromEntries(
    CLUES.flatMap((clue) =>
      ALL_CLUSTER_MASKS.map((mask) => [createClueAction(clue, mask), 0]),
    ),
  );

  for (const handKey of getKnownHandKeys(targetPlayer.globalPossibleHands)) {
    if (!targetPlayer.globalPossibleHands[handKey]) {
      continue;
    }

    const clueAction = clueToGive[handKey];
    if (clueAction === undefined) {
      continue;
    }

    clueCounts[clueAction] = (clueCounts[clueAction] ?? 0) + 1;
  }

  return Object.entries(clueCounts)
    .map(([clueAction, count]) => ({
      clueAction,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.clueAction.localeCompare(b.clueAction));
}

function renderClueHistogram(clueHistogram) {
  const histogram = getElement("clue-histogram");
  histogram.innerHTML = "";

  if (clueHistogram.length === 0) {
    histogram.innerHTML = '<li class="empty-histogram">No clue clusters</li>';
    return;
  }

  const maxCount = clueHistogram[0].count;

  for (const { clueAction, count } of clueHistogram) {
    const item = document.createElement("li");
    const width = maxCount === 0 ? 0 : (100 * count) / maxCount;
    item.innerHTML = `
      <div class="histogram-label">
        <span>${formatClueAction(clueAction)}</span>
        <strong>${count.toLocaleString()}</strong>
      </div>
      <div class="histogram-track">
        <div class="histogram-bar" style="width: ${width}%"></div>
      </div>
    `;
    histogram.append(item);
  }
}

function renderHistory() {
  const history = getElement("clue-history");
  history.innerHTML = "";
  getElement("history-title").textContent = isEverythingIsAClueMode()
    ? "Signal history"
    : "Clue history";

  if (state.clueHistory.length === 0) {
    history.innerHTML = `<li>${
      isEverythingIsAClueMode() ? "No signals yet" : "No clues yet"
    }</li>`;
    return;
  }

  for (const entry of state.clueHistory.slice(0, 8)) {
    const item = document.createElement("li");

    if (entry.type === "everything") {
      item.innerHTML = `
        <strong>${entry.giver}</strong> to <strong>${entry.receiver}</strong>:
        ${entry.actionText}
        <span>${entry.remainingHands.toLocaleString()} hands</span>
      `;
    } else {
      item.innerHTML = `
        <strong>${entry.giver}</strong> to <strong>${entry.receiver}</strong>:
        ${formatClue(entry.clue)}
        <span>${formatTouchedCards(entry.touchedCardIndexes)}</span>
        <span>${entry.remainingHands.toLocaleString()} hands</span>
      `;
    }

    history.append(item);
  }
}

function renderDiscards() {
  getElement("discard-count").textContent = `${state.discards.length}`;

  const discardList = getElement("discard-list");
  discardList.innerHTML = "";

  if (state.discards.length === 0) {
    discardList.innerHTML = "<li><span>No discards</span></li>";
    return;
  }

  for (const card of [...state.discards].reverse()) {
    const item = document.createElement("li");
    item.innerHTML = renderMiniCard(card);
    discardList.append(item);
  }
}

function calculateScore() {
  return COLORS.reduce((total, color) => total + state.playedStacks[color], 0);
}

function currentPlayer() {
  return state.players[state.currentPlayerIndex];
}

function getPartnerIndex(playerIndex) {
  return playerIndex === 0 ? 1 : 0;
}

function handToKey(hand) {
  return hand.join("|");
}

function getCardColor(card) {
  return card[0];
}

function getCardRank(card) {
  return card.slice(1);
}

function formatCard(card) {
  return `${COLOR_NAMES[getCardColor(card)]} ${getCardRank(card)}`;
}

function formatClue(clue) {
  return CLUE_LABELS[clue] ?? clue;
}

function formatClueAction(clueAction) {
  return `${formatClue(getClueActionClue(clueAction))} touching ${formatTouchedCards(
    getClueActionTouchedCardIndexes(clueAction),
  ).toLowerCase()}`;
}

function formatTouchedCards(touchedCardIndexes) {
  if (touchedCardIndexes.length === 1) {
    return `Card ${touchedCardIndexes[0]}`;
  }

  return `Cards ${touchedCardIndexes.join(", ")}`;
}

function getElement(id) {
  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`Missing element: ${id}`);
  }

  return element;
}

window.twoPlayerHanabi = {
  get state() {
    return state;
  },
  get allHandKeys() {
    return ALL_HAND_KEYS;
  },
};
