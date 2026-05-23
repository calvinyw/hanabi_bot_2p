# Two Player Hanabi Strategy Prototype

Self-contained browser prototype for experimenting with automated clue-giving
strategies in a simplified two-player Hanabi variant.

## Quick start

Browsers block ES modules on `file://`, so serve this folder over HTTP:

```bash
npm start
# open http://localhost:4173/two-player-hanabi.html
```

Or without npm:

```bash
npx serve . -p 4173
```

To try a different strategy module, change the import at the top of
`two-player-hanabi.mjs`.

## Overview

This prototype is for experimenting with automated clue-giving
strategies for two-player Hanabi. The goal is to build an interface where a
human can play a simplified two-player game while the page displays what clue
the strategy recommends and what the players' current hand-level possibilities
are.

Each new game starts on a setup screen. Choose:

- 2 players
- C colors, from 2 to 6
- R ranks, from 3 to 6
- H cards per hand, from 3 to 6

For each color, the deck has 3 copies of rank 1, 2 copies of each rank 2
through R-1, and 1 copy of rank R.

## Core Idea

Each player has a `globalPossibleHands` object. It is a dictionary from ordered
H-card hand keys to booleans:

```text
R1|Y2|G3|B4 -> true
R1|R1|R1|R1 -> false
```

The key says which cards might be in that player's hand, in slot order.
The boolean says whether that whole hand is still possible.

The interface tracks possibilities at the hand level rather than tracking an
independent possibility list for each card. This matters because clues can
create correlations between slots. For example, after a clue saying "Yellow
touching cards 1, 3, 4", the remaining possible hands should all have Yellow
cards exactly in slots 1, 3, and 4.

The app also prunes impossible hands using visible card counts. A hand is only
possible if, for every card identity, the number of copies in the hypothetical
hand plus the number of visible played or discarded copies is not greater than
the total number of copies in the deck.

## Clue Actions

The strategy does not represent a clue only as a color or number. It represents
a clue as:

```text
clue:touchMask
```

For example:

```text
Y:13
```

means a Yellow clue whose bitmask touches cards 1, 3, and 4. This full clue
action is important because the same color clue can mean different things
depending on which card slots it touches.

When a clue action `X` is given to a player, the app updates that player's
possibilities like this:

```text
globalPossibleHands[hand] =
  globalPossibleHands[hand] && clueToGive[hand] === X
```

The app then reapplies visible-copy pruning. Large setups use a sampled hand
universe so the browser remains responsive instead of trying to enumerate every
ordered hand.

## Strategy Flow

On each turn, the app recomputes the clue strategy for the target player from
the current game state and that player's current true hand possibilities.

The strategy file receives:

- `globalPossibleHands`: the target player's current hand possibilities
- `gameState`: played stacks, discards, clue tokens, strikes, deck count, and
  turn information

It returns:

```text
clueToGive[handKey] = clueAction
```

The interface looks up the target player's actual hand in that mapping and
displays the corresponding clue recommendation.

The number of possible clue-action clusters depends on the setup:

```text
(C + R) clue labels * (2^H - 1) nonempty touched-card subsets
```

The clue labels are the selected colors and ranks. The touched-card subsets are
the nonempty subsets of the configured H-card hand.

## `clue_logic.mjs`

This is the baseline random strategy.

For each hand key, it:

1. Finds every legal color clue and rank clue for that hand.
2. Picks one legal clue at random.
3. Converts it into a full clue action by computing which slots that clue
   touches.

This file is useful as the simplest possible imported clue logic, but it is not
trying to cluster hands or optimize clue quality.

## `cluster_clue_basic.mjs`

This file implements the first clustering strategy.

Each possible hand is embedded into a vector with one color one-hot, one rank
one-hot, and three status dimensions per card:

```text
H cards * (C color dimensions + R rank dimensions + 3 status dimensions)
```

For each card slot:

- the first C dimensions are a one-hot color encoding
- the next R dimensions are a one-hot rank encoding
- 1 dimension has value C+R if the card is currently playable, otherwise 0
- 1 dimension has value C+R if the card is trash, otherwise 0
- 1 dimension has value R+C/2 if the card is saved, otherwise 0

Trash cards intentionally zero out the color and rank one-hots, so a trash card
embeds as `(0xC, 0xR, 0, C+R, 0)`.

The algorithm clusters the currently true possible hands into the configured
clue-action clusters. A hand can only be assigned to clusters corresponding to
legal clues for that exact hand. For example, if a hand contains no Blue cards,
it cannot be assigned to any Blue clue cluster.

The modified k-means procedure is:

1. Initialization: assign each hand to the legal cluster with the smallest
   current cluster size.
2. Centroid update: recompute the centroid of every cluster from the hands
   currently assigned to it.
3. Reassignment: assign each hand to the closest nonempty centroid among only
   the legal clusters for that hand.
4. Repeat centroid update and reassignment until assignments stop changing or
   the iteration limit is reached.

After clustering, each hand maps to the clue action represented by its assigned
cluster.

## `cluster_clue_play_discard.mjs` and `cluster_clue_play_discard_v2.mjs`

These files use the same game-state features as `cluster_clue_basic.mjs`.
`two-player-hanabi.mjs` imports `cluster_clue_rebalance_first_times.mjs`.

Each possible hand uses the same setup-driven embedding:

```text
H cards * (C color + R rank + 1 playable + 1 trash + 1 saved)
```

For each card slot:

- C dimensions encode color
- R dimensions encode rank
- 1 dimension has value C+R if the card is currently playable, otherwise 0
- 1 dimension has value C+R if the card is trash, otherwise 0
- 1 dimension has value R+C/2 if the card is saved, otherwise 0

The card status features mean:

- `playable`: playing the card now would advance its color stack and not cause
  a strike.
- `trash`: the card can never matter again because that rank for that color has
  already been played.
- `saved`: the card is not playable and not trash, and all other copies of that
  card identity have been discarded.

This strategy uses the same configured legal clue-action clusters and the same
modified k-means structure as `cluster_clue_basic.mjs`. The main difference is
that the distance calculation sees playable, trash, and saved status, so the
clusters can group hands by strategically meaningful card roles rather than
only by color and rank identity.

## `cluster_clue_rebalance_first_times.mjs`

This file experiments with a two-phase clustering strategy that starts from the
same setup-driven playable, trash, and saved embedding used by
`cluster_clue_play_discard_v2.mjs`.

The first phase runs rebalance-aware k-means for `MAX_REBALANCE_LOOPS = 10`
loops. Each loop does:

1. Assign each hand to its closest legal nonempty centroid.
2. Run 3 rebalance passes, moving hands out of oversized clusters when there is
   a smaller legal cluster available.
3. Recompute centroids from the rebalanced assignments.

The second phase then runs normal k-means for `MAX_NORMAL_LOOPS = 10` loops,
using the centroids and assignments produced by the rebalance-aware phase as
its initialization. This lets the early iterations push the clusters toward a
more even distribution, then lets the final iterations settle by ordinary
nearest-centroid distance without additional rebalancing.

## Interface Knowledge Markers

The display derives card-slot knowledge from `globalPossibleHands`:

- lime-green outline: every possible hand has that slot playable
- pink outline: every possible hand has that slot saved
- alternating lime-green and pink outline: every possible hand has that slot
  either playable or saved, but it is not known which one
- trash marker: every possible hand has that slot trash

These markers are computed from the remaining hand-level possibilities, not
from the actual hidden card identity.
