const COLORS = ["R", "Y", "G", "B"];
const RANKS = ["1", "2", "3", "4"];

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

export function createRandomClueMapping(globalPossibleHands, gameState) {
  void gameState;

  const clueToGive = {};

  for (const handKey of Object.keys(globalPossibleHands)) {
    clueToGive[handKey] = pickRandomClueForHand(handKey, gameState);
  }

  return clueToGive;
}

function pickRandomClueForHand(handKey) {
  const identities = handKey.split("|");
  const legalClues = [];

  for (const color of COLORS) {
    if (identities.some((identity) => identity.startsWith(color))) {
      legalClues.push(color);
    }
  }

  for (const rank of RANKS) {
    if (identities.some((identity) => identity.endsWith(rank))) {
      legalClues.push(rank);
    }
  }

  const clue = legalClues[Math.floor(Math.random() * legalClues.length)] ?? "1";

  return createClueAction(clue, handKey);
}

function createClueAction(clue, handKey) {
  const touchedMask = handKey
    .split("|")
    .reduce(
      (mask, card, cardIndex) =>
        card[0] === clue || card[1] === clue ? mask | (1 << cardIndex) : mask,
      0,
    );

  return `${clue}:${touchedMask}`;
}
