import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runScoring, validateModel } from '../src/analyze.js';

const MODEL = {
  kind: 'training-scale/rasch-model',
  modelVersion: 1,
  items: { q1: { version: 'v1' }, q2: { version: 'v1' }, q3: { version: 'v1' } },
  parameters: {
    constraint: 'anchor-mean-zero',
    difficulties: {
      q1: { kind: 'anchor', value: -0.5, se: 0.2, n: 100 },
      q2: { kind: 'anchor', value: 0.5, se: 0.2, n: 100 },
      q3: { kind: 'item', byLanguage: { zh: { value: 0.1, se: 0.3, n: 50 }, en: { value: 0.9, se: 0.3, n: 50 } } },
    },
  },
};

const record = (participant, item, correct, id, extra = {}) => ({
  id, participant, item, language: 'zh', correct, answered: true, version: 'v1', ...extra,
});

test('冻结评分：档案逐字节不变，难度不被重新估计', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'scoring-'));
  try {
    const modelPath = join(folder, 'model.json');
    await writeFile(modelPath, JSON.stringify(MODEL, null, 2));
    const before = await readFile(modelPath, 'utf8');
    const records = [
      record('n1', 'q1', 1, 'r1'), record('n1', 'q2', 0, 'r2'), record('n1', 'q3', 1, 'r3'),
      record('n2', 'q1', 0, 'r4'), record('n2', 'q2', 1, 'r5'), record('n2', 'q3', 0, 'r6'),
    ];
    const result = runScoring(records, MODEL);
    assert.equal(await readFile(modelPath, 'utf8'), before, '评分不得改动模型档案');
    assert.equal(result.difficultiesFrozen, true);
    assert.equal(result.persons.length, 2);
    const [first] = result.persons;
    assert.ok(Number.isFinite(first.theta));
    assert.ok(first.se > 0);
    // 档案中的难度原样使用：q1 为共享锚题 -0.5
    assert.equal(MODEL.parameters.difficulties.q1.value, -0.5);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('题目版本不符与未知题被响亮排除，不悄悄改用其他难度', () => {
  const records = [
    record('n1', 'q1', 1, 'r1'),
    record('n1', 'q2', 0, 'r2', { version: 'v2' }), // 版本不符
    record('n1', 'q9', 1, 'r3'), // 档案中不存在
    record('n1', 'q3', 0, 'r4'),
  ];
  const result = runScoring(records, MODEL);
  const person = result.persons[0];
  assert.deepEqual(
    person.excluded.map(entry => entry.reason).sort(),
    ['unknown-item', 'version-mismatch']
  );
  assert.equal(person.answered, 2, '只有 q1 与 q3 参与评分');
  assert.ok(result.excludedSummary['q2 (version-mismatch)'] === 1);
  assert.ok(result.excludedSummary['q9 (unknown-item)'] === 1);
});

test('没有对应语种难度时该题被排除并说明', () => {
  const records = [
    record('n1', 'q1', 1, 'r1', { language: 'en' }),
    record('n1', 'q2', 0, 'r2', { language: 'en' }),
    record('n1', 'q3', 1, 'r3', { language: 'en' }),
  ];
  const result = runScoring(records, MODEL);
  const person = result.persons[0];
  // q3 在档案中有 en 难度 0.9，q1/q2 为共享锚题：三题都应可用
  assert.equal(person.answered, 3);
  // 换成档案中没有 en 难度的模型
  const model = JSON.parse(JSON.stringify(MODEL));
  delete model.parameters.difficulties.q3.byLanguage.en;
  const second = runScoring(records, model);
  assert.deepEqual(second.persons[0].excluded.map(entry => entry.reason), ['no-difficulty-for-language']);
  assert.equal(second.persons[0].answered, 2);
});

test('全对或全错的新批次参与者：能力无界，theta 记为 null 并标注', () => {
  const records = [
    record('perfect', 'q1', 1, 'r1'), record('perfect', 'q2', 1, 'r2'), record('perfect', 'q3', 1, 'r3'),
    record('zero', 'q1', 0, 'r4'), record('zero', 'q2', 0, 'r5'), record('zero', 'q3', 0, 'r6'),
    record('mixed', 'q1', 1, 'r7'), record('mixed', 'q2', 0, 'r8'), record('mixed', 'q3', 0, 'r9'),
  ];
  const result = runScoring(records, MODEL);
  const perfect = result.persons.find(person => person.participant === 'perfect');
  const zero = result.persons.find(person => person.participant === 'zero');
  const mixed = result.persons.find(person => person.participant === 'mixed');
  assert.equal(perfect.theta, null);
  assert.equal(perfect.extreme, 'all-correct');
  assert.equal(zero.theta, null);
  assert.equal(zero.extreme, 'all-wrong');
  assert.ok(Number.isFinite(mixed.theta));
});

test('模型档案校验：kind、版本与已发布参数缺一不可评分', () => {
  assert.throws(() => validateModel(null), /对象/);
  assert.throws(() => validateModel({ ...MODEL, kind: 'other' }), /kind/);
  assert.throws(() => validateModel({ ...MODEL, modelVersion: 2 }), /版本/);
  assert.throws(() => validateModel({ ...MODEL, parameters: null }), /参数/);
  assert.throws(() => validateModel({ ...MODEL, items: undefined }), /题目版本/);
});

test('analyze 出档案、score 冻结评分的命令行闭环', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cli-analysis-'));
  try {
    const modelPath = join(folder, 'model.json');
    const analyze = spawnSync(process.execPath, ['src/cli.js', 'analyze', '--out', modelPath], { encoding: 'utf8' });
    assert.equal(analyze.status, 0, analyze.stderr);
    const model = JSON.parse(await readFile(modelPath, 'utf8'));
    assert.equal(model.kind, 'training-scale/rasch-model');
    assert.ok(model.usage.includes('不构成'));
    // 演练数据的两个语言版本在剔除极端单元格后断连：不得声称等值、不得出具参数
    assert.equal(model.equating.status, 'disconnected');
    assert.equal(model.parameters, null);
    assert.ok(model.reviewList.length > 0);

    // 用合成档案评分（含版本不符题与全对的人）
    const archive = { ...MODEL, inputFingerprint: 'x'.repeat(64) };
    const archivePath = join(folder, 'archive.json');
    await writeFile(archivePath, JSON.stringify(archive, null, 2));
    const batch = {
      version: 1,
      records: [
        record('n1', 'q1', 1, 'r1'), record('n1', 'q2', 0, 'r2'), record('n1', 'q3', 1, 'r3'),
        record('n2', 'q1', 1, 'r4'), record('n2', 'q2', 1, 'r5'), record('n2', 'q3', 1, 'r6'),
        record('n3', 'q1', 1, 'r7', { version: 'v2' }),
      ],
    };
    const batchPath = join(folder, 'batch.json');
    await writeFile(batchPath, JSON.stringify(batch));
    const scoresPath = join(folder, 'scores.json');
    const archiveBefore = await readFile(archivePath, 'utf8');
    const score = spawnSync(process.execPath,
      ['src/cli.js', 'score', '--input', batchPath, '--model', archivePath, '--out', scoresPath],
      { encoding: 'utf8' });
    assert.equal(score.status, 0, score.stderr);
    assert.equal(await readFile(archivePath, 'utf8'), archiveBefore, '评分后档案逐字节不变');
    const scores = JSON.parse(await readFile(scoresPath, 'utf8'));
    assert.equal(scores.kind, 'training-scale/rasch-scores');
    assert.equal(scores.difficultiesFrozen, true);
    const perfect = scores.persons.find(person => person.participant === 'n2');
    assert.equal(perfect.theta, null);
    assert.equal(perfect.extreme, 'all-correct');
    const mismatched = scores.persons.find(person => person.participant === 'n3');
    assert.equal(mismatched.reason, 'no-estimable-items');
    assert.equal(mismatched.excluded[0].reason, 'version-mismatch');

    // score 缺少 --model 直接报错
    const missing = spawnSync(process.execPath, ['src/cli.js', 'score', '--input', batchPath], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--model/);
    // analyze 默认配置路径可用，且未知命令仍被拒绝
    assert.equal(spawnSync(process.execPath, ['src/cli.js', 'unknown']).status, 1);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
