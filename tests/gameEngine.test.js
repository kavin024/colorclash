/**
 * Color Clash – Game Engine Tests
 */

const {
    createDeck,
    shuffle,
    isValidPlay,
    applyCardEffect,
    drawCards,
    checkWin,
    reshuffleDiscardIntoDraw,
} = require('../src/gameEngine');

describe('createDeck', () => {
    test('produces exactly 108 cards', () => {
        expect(createDeck()).toHaveLength(108);
    });

    test('has 4 × 1 zero cards (one per color)', () => {
        const zeros = createDeck().filter((c) => c.type === 'number' && c.value === 0);
        expect(zeros).toHaveLength(4);
    });

    test('has 8 wild cards total (4 wild + 4 wild_draw_four)', () => {
        const deck = createDeck();
        expect(deck.filter((c) => c.type === 'wild')).toHaveLength(4);
        expect(deck.filter((c) => c.type === 'wild_draw_four')).toHaveLength(4);
    });

    test('has 8 skip cards (2 per color)', () => {
        const deck = createDeck();
        expect(deck.filter((c) => c.type === 'skip')).toHaveLength(8);
    });
});

describe('shuffle', () => {
    test('preserves card count', () => {
        const deck = createDeck();
        expect(shuffle([...deck])).toHaveLength(108);
    });

    test('is not identical to original (with overwhelming probability)', () => {
        const deck = createDeck();
        const shuffled = shuffle([...deck]);
        const same = shuffled.every((c, i) => JSON.stringify(c) === JSON.stringify(deck[i]));
        expect(same).toBe(false);
    });
});

describe('isValidPlay', () => {
    const top = { color: 'red', type: 'number', value: 5 };

    test('same color is valid', () => {
        expect(isValidPlay({ color: 'red', type: 'number', value: 3 }, top, 'red')).toBe(true);
    });

    test('same number is valid', () => {
        expect(isValidPlay({ color: 'blue', type: 'number', value: 5 }, top, 'red')).toBe(true);
    });

    test('different color and number is invalid', () => {
        expect(isValidPlay({ color: 'blue', type: 'number', value: 7 }, top, 'red')).toBe(false);
    });

    test('wild is always valid', () => {
        expect(isValidPlay({ color: 'wild', type: 'wild' }, top, 'red')).toBe(true);
    });

    test('wild_draw_four is always valid', () => {
        expect(isValidPlay({ color: 'wild', type: 'wild_draw_four' }, top, 'red')).toBe(true);
    });

    test('skip on skip matches type', () => {
        const skipTop = { color: 'blue', type: 'skip' };
        expect(isValidPlay({ color: 'red', type: 'skip' }, skipTop, 'blue')).toBe(true);
    });

    test('plays on active wild color', () => {
        const wildTop = { color: 'wild', type: 'wild' };
        expect(isValidPlay({ color: 'green', type: 'number', value: 1 }, wildTop, 'green')).toBe(true);
    });
});

describe('applyCardEffect', () => {
    function makeGame(numPlayers = 3) {
        const players = Array.from({ length: numPlayers }, (_, i) => ({
            id: `p${i}`,
            nickname: `P${i}`,
            hand: Array(5).fill({ color: 'red', type: 'number', value: 1 }),
            clashSafe: false,
        }));
        return {
            players,
            currentPlayerIndex: 0,
            direction: 1,
            drawPile: Array(30).fill({ color: 'red', type: 'number', value: 2 }),
            discardPile: [],
            currentColor: 'red',
        };
    }

    test('number card advances turn', () => {
        const game = makeGame();
        applyCardEffect(game, { color: 'red', type: 'number', value: 3 }, null);
        expect(game.currentPlayerIndex).toBe(1);
    });

    test('skip advances by 2', () => {
        const game = makeGame();
        applyCardEffect(game, { color: 'red', type: 'skip' }, null);
        expect(game.currentPlayerIndex).toBe(2);
    });

    test('reverse flips direction', () => {
        const game = makeGame(4);
        applyCardEffect(game, { color: 'red', type: 'reverse' }, null);
        expect(game.direction).toBe(-1);
    });

    test('draw_two gives 2 cards to next player and skips them', () => {
        const game = makeGame();
        const before = game.players[1].hand.length;
        applyCardEffect(game, { color: 'red', type: 'draw_two' }, null);
        expect(game.players[1].hand.length).toBe(before + 2);
        expect(game.currentPlayerIndex).toBe(2);
    });

    test('wild sets chosen color', () => {
        const game = makeGame();
        applyCardEffect(game, { color: 'wild', type: 'wild' }, 'blue');
        expect(game.currentColor).toBe('blue');
    });

    test('wild_draw_four gives 4 cards to next player and skips them', () => {
        const game = makeGame();
        const before = game.players[1].hand.length;
        applyCardEffect(game, { color: 'wild', type: 'wild_draw_four' }, 'green');
        expect(game.players[1].hand.length).toBe(before + 4);
        expect(game.currentColor).toBe('green');
        expect(game.currentPlayerIndex).toBe(2);
    });
});

describe('checkWin', () => {
    test('returns true when hand is empty', () => {
        expect(checkWin({ hand: [] })).toBe(true);
    });
    test('returns false when hand has cards', () => {
        expect(checkWin({ hand: [{ color: 'red', type: 'number', value: 1 }] })).toBe(false);
    });
});

describe('reshuffleDiscardIntoDraw', () => {
    test('moves discard (except top) to draw pile', () => {
        const game = {
            drawPile: [],
            discardPile: [1, 2, 3, 4, 5],
        };
        reshuffleDiscardIntoDraw(game);
        expect(game.discardPile).toHaveLength(1);
        expect(game.drawPile).toHaveLength(4);
    });
});
