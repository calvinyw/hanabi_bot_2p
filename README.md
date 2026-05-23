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

The current variant uses:

- 2 players
- 4 cards per hand
- 4 colors: Red, Yellow, Green, Blue
- 4 ranks: 1, 2, 3, 4
- 32 total cards
- 3 copies of each 1, 2 copies of each 2, 2 copies of each 3, and 1 copy of
  each 4

## Core Idea

Each player has a `globalPossibleHands` object. It is a dictionary from ordered
four-card hand keys to booleans:

```text
R1|Y2|G3|B4 -> true
R1|R1|R1|R1 -> false
```

The key says which four cards might be in that player's hand, in slot order.
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

The app then reapplies visible-copy pruning.

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

There are 120 possible clue-action clusters:

```text
8 clue labels * 15 nonempty touched-card subsets = 120
```

The 8 clue labels are the 4 colors and 4 ranks. The 15 touched-card subsets are
the nonempty subsets of a 4-card hand.

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

Each possible hand is embedded into a 32-dimensional vector:

```text
4 cards * (4 color dimensions + 4 rank dimensions) = 32 dimensions
```

For each card slot:

- the first 4 dimensions are a one-hot color encoding
- the next 4 dimensions are a one-hot rank encoding

The algorithm clusters the currently true possible hands into the 120 possible
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

These files extend `cluster_clue_basic.mjs` by adding game-state features to the
embedding. `two-player-hanabi.mjs` imports `cluster_clue_play_discard_v2.mjs`.

Each possible hand is embedded into a 44-dimensional vector:

```text
4 cards * (4 color + 4 rank + 1 playable + 1 trash + 1 saved) = 44 dimensions
```

For each card slot:

- 4 dimensions encode color
- 4 dimensions encode rank
- 1 dimension has value 8 if the card is currently playable, otherwise 0
- 1 dimension has value 8 if the card is trash, otherwise 0
- 1 dimension has value 3 if the card is saved, otherwise 0

The card status features mean:

- `playable`: playing the card now would advance its color stack and not cause
  a strike.
- `trash`: the card can never matter again because that rank for that color has
  already been played.
- `saved`: the card is not playable and not trash, and all other copies of that
  card identity have been discarded.

This strategy uses the same 120 legal clue-action clusters and the same
modified k-means structure as `cluster_clue_basic.mjs`. The main difference is
that the distance calculation sees playable, trash, and saved status, so the
clusters can group hands by strategically meaningful card roles rather than
only by color and rank identity.

This file also adds a small cluster-size balance penalty during reassignment:

```text
distance + 0.1 * log(clusterSize + 1)
```

That keeps the closest-centroid step from overloading a single large legal
cluster when another legal cluster is nearly as close.

## `cluster_clue_rebalance_first_times.mjs`

This file experiments with a two-phase clustering strategy that starts from the
same 44-dimensional playable, trash, and saved embedding used by
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
