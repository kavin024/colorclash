/**
 * Color Clash – Game Engine
 * Server-authoritative deck management, validation, and effects.
 */

const COLORS = ['red', 'blue', 'green', 'yellow'];

const SPECIAL_TYPES = ['skip', 'reverse', 'draw_two'];
const WILD_TYPES = ['wild', 'wild_draw_four'];

/** Build a fresh 108-card Color Clash deck */
function createDeck() {
  const deck = [];

  for (const color of COLORS) {
    // One '0' card per color
    deck.push({ color, type: 'number', value: 0 });

    // Two each of 1-9, skip, reverse, draw_two
    for (let i = 1; i <= 9; i++) {
      deck.push({ color, type: 'number', value: i });
      deck.push({ color, type: 'number', value: i });
    }
    for (const type of SPECIAL_TYPES) {
      deck.push({ color, type });
      deck.push({ color, type });
    }
  }

  // 4 wilds + 4 wild_draw_fours
  for (let i = 0; i < 4; i++) {
    deck.push({ color: 'wild', type: 'wild' });
    deck.push({ color: 'wild', type: 'wild_draw_four' });
  }

  return deck;
}

/** Fisher-Yates in-place shuffle */
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** Deal 7 cards to each player; set up draw/discard piles. */
function dealCards(game) {
  for (const player of game.players) {
    player.hand = [];
    for (let i = 0; i < 7; i++) {
      const card = game.drawPile.pop();
      player.hand.push(card);
    }
  }

  // Flip starting discard (skip wilds as first card)
  let startCard;
  do {
    startCard = game.drawPile.pop();
    if (WILD_TYPES.includes(startCard.type)) {
      game.drawPile.unshift(startCard); // put back at bottom
      startCard = null;
    }
  } while (!startCard);

  game.discardPile = [startCard];
  game.currentColor = startCard.color;
}

/** Return the top of the discard pile */
function topCard(game) {
  return game.discardPile[game.discardPile.length - 1];
}

/**
 * Check if a card can be legally played.
 * @param {object} card – card from player's hand
 * @param {object} top – top of discard pile
 * @param {string} currentColor – active color (may differ from top.color for wild)
 */
function isValidPlay(card, top, currentColor) {
  if (WILD_TYPES.includes(card.type)) return true;
  if (card.color === currentColor) return true;
  if (card.type === 'number' && top.type === 'number' && card.value === top.value) return true;
  if (card.type !== 'number' && card.type === top.type) return true;
  return false;
}

/**
 * Get the index of the next player, respecting direction.
 */
function nextPlayerIndex(game, skip = false) {
  const n = game.players.length;
  const step = game.direction * (skip ? 2 : 1);
  return ((game.currentPlayerIndex + step) % n + n) % n;
}

/**
 * Apply a card's effect to the game state after it is played.
 * Returns the next player index.
 */
function applyCardEffect(game, card, chosenColor) {
  switch (card.type) {
    case 'wild':
    case 'wild_draw_four': {
      game.currentColor = chosenColor || 'red';
      if (card.type === 'wild_draw_four') {
        const nextIdx = nextPlayerIndex(game);
        drawCards(game, nextIdx, 4);
        game.currentPlayerIndex = nextPlayerIndex(game, true);
      } else {
        game.currentPlayerIndex = nextPlayerIndex(game);
      }
      break;
    }
    case 'skip': {
      game.currentPlayerIndex = nextPlayerIndex(game, true);
      break;
    }
    case 'reverse': {
      if (game.players.length === 2) {
        // In 2-player, reverse acts like skip
        game.currentPlayerIndex = nextPlayerIndex(game, true);
      } else {
        game.direction *= -1;
        game.currentPlayerIndex = nextPlayerIndex(game);
      }
      break;
    }
    case 'draw_two': {
      const nextIdx = nextPlayerIndex(game);
      drawCards(game, nextIdx, 2);
      game.currentPlayerIndex = nextPlayerIndex(game, true);
      break;
    }
    default: {
      // number card
      game.currentColor = card.color;
      game.currentPlayerIndex = nextPlayerIndex(game);
    }
  }
}

/** Draw `count` cards from the pile for a player (auto-reshuffle if needed) */
function drawCards(game, playerIndex, count) {
  const player = game.players[playerIndex];
  for (let i = 0; i < count; i++) {
    if (game.drawPile.length === 0) reshuffleDiscardIntoDraw(game);
    if (game.drawPile.length === 0) break; // still empty (edge case)
    player.hand.push(game.drawPile.pop());
  }
}

/** Reshuffle discard pile (except top card) into draw pile */
function reshuffleDiscardIntoDraw(game) {
  if (game.discardPile.length <= 1) return;
  const top = game.discardPile.pop();
  game.drawPile = shuffle(game.discardPile);
  game.discardPile = [top];
}

/** Returns true if the player has won (0 cards left) */
function checkWin(player) {
  return player.hand.length === 0;
}

/**
 * Serialize the game state safe to send to ALL clients.
 * Hides other players' hands.
 */
function publicGameState(game) {
  return {
    phase: game.phase,
    currentPlayerIndex: game.currentPlayerIndex,
    currentColor: game.currentColor,
    direction: game.direction,
    drawPileCount: game.drawPile.length,
    discardTop: topCard(game),
    players: game.players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      cardCount: p.hand.length,
      isConnected: p.isConnected,
    })),
    turnStartedAt: game.turnStartedAt,
    winner: game.winner || null,
    clashCalledBy: game.clashCalledBy || null,
  };
}

module.exports = {
  createDeck,
  shuffle,
  dealCards,
  isValidPlay,
  applyCardEffect,
  drawCards,
  reshuffleDiscardIntoDraw,
  checkWin,
  publicGameState,
  topCard,
  nextPlayerIndex,
  COLORS,
  WILD_TYPES,
};
