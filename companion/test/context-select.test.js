import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSections, selectContext } from '../src/context-select.js';
import { buildMessages, buildSystemParts } from '../src/prompt.js';

const ctx = { character: { class: 'HUNTER' }, bank: [1], spells: [2], knownFlightPaths: ['Ironforge'], auctionPrices: [3] };

test('leaves out big sections the question does not need and lists them', () => {
  const { context, omitted } = selectContext(ctx, 'Which dungeon should I run?');
  assert.deepEqual(omitted, ['bank', 'spells', 'knownFlightPaths', 'auctionPrices']);
  assert.equal(context.character.class, 'HUNTER');
  assert.deepEqual(context.omittedSections, omitted);
});

test('keeps the sections the question or an open window asks for', () => {
  assert.equal(selectContext(ctx, 'How do I get to Ironforge?').context.knownFlightPaths.length, 1);
  assert.ok(selectContext(ctx, 'what is in my bank?').context.bank);
  assert.ok(selectContext({ ...ctx, screen: { merchant: {} }, merchant: {} }, 'what should I do?').context.auctionPrices);
});

test('get_character_data only returns known sections', () => {
  assert.deepEqual(pickSections({ ...ctx, secret: 1 }, ['bank', 'secret', 'nope']), { bank: [1] });
});

test('buildMessages can send everything', () => {
  const req = { question: 'hi', context: ctx };
  assert.ok(!buildMessages(req).at(-1).content.includes('"Ironforge"'));
  assert.ok(buildMessages(req, { select: false }).at(-1).content.includes('"Ironforge"'));
});

test('the stable part of the system prompt does not change with the question', () => {
  const a = buildSystemParts('', 'fizzi', { question: 'where is the Deadmines?' });
  const b = buildSystemParts('', 'fizzi', { question: 'best hunter pet?' });
  assert.equal(a.stable, b.stable);
});
