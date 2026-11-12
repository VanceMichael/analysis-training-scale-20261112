import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarize } from '../src/domain.js';

const seed = JSON.parse(await readFile('data/records.json', 'utf8')).records[0];
const probe = patches => summarize(patches.map((patch, index) => ({...seed, id: `p${index}`, ...patch}))).groups[0];

test('缺答与答错有不同的已答计数', () => {

  assert.equal(probe([{answered: false, correct: 0}, {answered: true, correct: 0}]).answered, 1);
  assert.equal(probe([{answered: false, correct: 0}]).answered, 0);
});
