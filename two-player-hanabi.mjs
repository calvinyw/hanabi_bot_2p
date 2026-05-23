import {
  CLUE_LABELS,
  createClueAction,
  createClusterClueMapping,
  getClueActionClue,
  getClueActionTouchedCardIndexes,
} from "./cluster_clue_play_discard_v2.mjs";

const COLORS = ["R", "Y", "G", "B"];
const RANKS = ["1", "2", "3", "4"];
const CLUES = [...COLORS, ...RANKS];
const ALL_CLUSTER_MASKS = Array.from({ length: 15 }, (_, index) => index + 1);
const COLOR_NAMES = {
  R: "Red",
  Y: "Yellow",
  G: "Green",
  B: "Blue",
};
const CARD_IDENTITIES = COLORS.flatMap((color) =>
  [1, 2, 3, 4].map((rank) => `${color}${rank}`),
);
const HIGHEST_RANK = 4;
const TOTAL_CARD_COPIES = Object.fromEntries(
  CARD_IDENTITIES.map((card) => [card, getTotalCardCopies(card)]),
);
const HAND_SIZE = 4;
const MAX_CLUE_TOKENS = 8;
const MAX_STRIKES = 3;
const POSSIBILITY_SAMPLE_LIMIT = 60;
const ALL_HAND_KEYS = buildAllHandKeys();

const state = {
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
  message: "New game ready.",
  gameOver: false,
};

document.addEventListener("DOMContentLoaded", () => {
  bindControls();
  startNewGame();
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
      startNewGame();
      return;
    }

    if (state.gameOver) {
      return;
    }

    if (action === "give-clue") {
      giveStrategyClue();
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
      render();
    }
  });
}

function startNewGame() {
  state.deck = shuffle(buildDeck());
  state.discards = [];
  state.playedStacks = {
    R: 0,
    Y: 0,
    G: 0,
    B: 0,
  };
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
    player.globalPossibleHands = createGlobalPossibleHands(true);
    player.possibleVersion = 0;
    player.possibilitySnapshot = summarizePossibleHands(player.globalPossibleHands);
  }

  for (let cardIndex = 0; cardIndex < HAND_SIZE; cardIndex++) {
    for (const player of state.players) {
      const card = drawCard();
      if (card !== undefined) {
        player.hand.push(card);
      }
    }
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

    for (const rank of [2, 3]) {
      for (let copy = 0; copy < 2; copy++) {
        deck.push(`${color}${rank}`);
      }
    }

    deck.push(`${color}${HIGHEST_RANK}`);
  }

  return deck;
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

  for (const card1 of CARD_IDENTITIES) {
    for (const card2 of CARD_IDENTITIES) {
      for (const card3 of CARD_IDENTITIES) {
        for (const card4 of CARD_IDENTITIES) {
          handKeys.push(`${card1}|${card2}|${card3}|${card4}`);
        }
      }
    }
  }

  return handKeys;
}

function createGlobalPossibleHands(initialValue) {
  const globalPossibleHands = Object.create(null);
  const unavailableCounts = getVisibleUnavailableCardCounts();

  for (const handKey of ALL_HAND_KEYS) {
    globalPossibleHands[handKey] =
      initialValue && isHandPossibleWithVisibleCopies(handKey, unavailableCounts);
  }

  return globalPossibleHands;
}

function summarizePossibleHands(globalPossibleHands) {
  let count = 0;
  const sample = [];

  for (const handKey of ALL_HAND_KEYS) {
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
    state.message = "The strategy can only clue a four-card hand.";
    render();
    return;
  }

  applyClue(targetPlayerIndex, strategy.clueToGive, clueAction);

  state.clueTokens--;
  state.message = `${currentPlayer().name} gave ${targetPlayer.name} ${formatClueAction(
    clueAction,
  )}.`;
  state.clueHistory.unshift({
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

  for (const handKey of ALL_HAND_KEYS) {
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

function playCard(cardIndex) {
  const player = currentPlayer();
  const card = player.hand[cardIndex];

  if (card === undefined) {
    return;
  }

  const color = card[0];
  const rank = Number.parseInt(card[1] ?? "0", 10);
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
  finishAction();
}

function discardCard(cardIndex) {
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
  finishAction();
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

  for (const handKey of ALL_HAND_KEYS) {
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
      nextGlobalPossibleHands[nextHandKey] =
        isHandPossibleWithVisibleCopies(nextHandKey, unavailableCounts);
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

    for (const handKey of ALL_HAND_KEYS) {
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
    handCounts[card] = (handCounts[card] ?? 0) + 1;

    if (handCounts[card] + unavailableCounts[card] > TOTAL_CARD_COPIES[card]) {
      return false;
    }
  }

  return true;
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
  };
}

function render() {
  const strategy = state.gameOver ? undefined : getCurrentStrategy();
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
  getElement("recommended-summary").textContent =
    recommendedClueAction === undefined
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
  const canSeeCards = !isCurrentPlayer || state.revealAllCards;
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
    <div class="hand-row">${cards}</div>
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
  const color = card[0];
  const rank = card[1];
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

  for (const handKey of ALL_HAND_KEYS) {
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

  for (const handKey of ALL_HAND_KEYS) {
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
  const color = card[0];
  const rank = Number.parseInt(card[1] ?? "0", 10);
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
  return `<span class="mini-card mini-${card[0]}">${card}</span>`;
}

function renderStrategyPanel(recommendedClueAction, targetPlayer, clueHistogram) {
  getElement("strategy-target").textContent = targetPlayer.name;
  getElement("strategy-clue").textContent =
    recommendedClueAction === undefined
      ? "No clue"
      : formatClueAction(recommendedClueAction);
  getElement("strategy-actual-hand").innerHTML = renderHandKey(
    handToKey(targetPlayer.hand),
  );

  const clueButton = getElement("give-clue-button");
  clueButton.textContent =
    recommendedClueAction === undefined
      ? "Give clue"
      : `Give ${formatClue(getClueActionClue(recommendedClueAction))}`;
  clueButton.toggleAttribute(
    "disabled",
    recommendedClueAction === undefined || state.clueTokens === 0 || state.gameOver,
  );

  renderClueHistogram(clueHistogram);
}

function getClueHistogram(clueToGive, targetPlayer) {
  const clueCounts = Object.fromEntries(
    CLUES.flatMap((clue) =>
      ALL_CLUSTER_MASKS.map((mask) => [createClueAction(clue, mask), 0]),
    ),
  );

  for (const handKey of ALL_HAND_KEYS) {
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

  if (state.clueHistory.length === 0) {
    history.innerHTML = "<li>No clues yet</li>";
    return;
  }

  for (const entry of state.clueHistory.slice(0, 8)) {
    const item = document.createElement("li");
    item.innerHTML = `
      <strong>${entry.giver}</strong> to <strong>${entry.receiver}</strong>:
      ${formatClue(entry.clue)}
      <span>${formatTouchedCards(entry.touchedCardIndexes)}</span>
      <span>${entry.remainingHands.toLocaleString()} hands</span>
    `;
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

function formatCard(card) {
  return `${COLOR_NAMES[card[0]]} ${card[1]}`;
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
  allHandKeys: ALL_HAND_KEYS,
};
