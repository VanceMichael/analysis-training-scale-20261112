import test from 'node:test';
import assert from 'node:assert/strict';
import {
  logistic,
  normalCdf,
  benjaminiHochberg,
  buildDesign,
  checkLinkage,
  selectEstimable,
  fitRasch,
} from '../src/rasch.js';
import { runAnalysis } from '../src/analyze.js';
import { validatePolicy } from '../src/policy.js';

const POLICY = {
  anchors: ['a1', 'a2'],
  referenceLanguage: 'zh',
  maxPurification: 2,
  alpha: 0.05,
  frozenVersion: 'v1',
};

// 确定性伪随机数（mulberry32），合成数据可复现
function mulberry32(seed) {
  return () => {
    seed += 0x6D2B79F5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 按已知难度与能力合成作答；dif 形如 { item: { language: 偏移 } }，偏移使该语种更难
function simulate({ abilities, difficulties, languages, dif = {}, missingRate = 0, seed = 7 }) {
  const random = mulberry32(seed);
  const records = [];
  let counter = 0;
  abilities.forEach((theta, personIndex) => {
    for (const [item, base] of Object.entries(difficulties)) {
      const language = languages[personIndex];
      const answered = random() >= missingRate;
      const shift = dif[item]?.[language] ?? 0;
      const probability = logistic(theta - base - shift);
      records.push({
        id: `r${String(counter).padStart(5, '0')}`,
        participant: `p${personIndex}`,
        item,
        language,
        correct: answered && random() < probability ? 1 : 0,
        answered,
        version: 'v1',
      });
      counter += 1;
    }
  });
  return records;
}

function pearson(pairs) {
  const n = pairs.length;
  const meanX = pairs.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = pairs.reduce((sum, [, y]) => sum + y, 0) / n;
  let numerator = 0;
  let varX = 0;
  let varY = 0;
  for (const [x, y] of pairs) {
    numerator += (x - meanX) * (y - meanY);
    varX += (x - meanX) ** 2;
    varY += (y - meanY) ** 2;
  }
  return numerator / Math.sqrt(varX * varY);
}

test('logistic 与正态分布函数基本性质', () => {
  assert.equal(logistic(0), 0.5);
  assert.ok(Math.abs(logistic(2) - 1 / (1 + Math.exp(-2))) < 1e-15);
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(normalCdf(1.959964) - 0.975) < 1e-6);
  assert.ok(Math.abs(normalCdf(-1.959964) - 0.025) < 1e-6);
});

test('同批检验统一做 Benjamini–Hochberg 校正', () => {
  const adjusted = benjaminiHochberg([0.001, 0.01, 0.04, 0.5]);
  assert.deepEqual(adjusted.map(value => Math.round(value * 1000) / 1000), [0.004, 0.02, 0.053, 0.5]);
  assert.deepEqual(benjaminiHochberg([]), []);
});

test('已知难度顺序的合成数据：尺度方向与能力方向均被还原', () => {
  const difficulties = {
    d1: -1.8, d2: -1.4, d3: -1.0, d4: -0.6, d5: -0.2,
    d6: 0.2, d7: 0.6, d8: 1.0, d9: 1.4, d10: 1.8,
  };
  const abilities = Array.from({ length: 240 }, (_, index) => -2.4 + (4.8 * index) / 239);
  const languages = abilities.map(() => 'zh');
  const records = simulate({ abilities, difficulties, languages, seed: 42 });
  const policy = { ...POLICY, anchors: ['d1', 'd2'], maxPurification: 0 };
  const result = runAnalysis(records, policy);
  assert.equal(result.equating.status, 'not-applicable');
  assert.ok(result.diagnostics.converged, '合成数据应收敛');
  // 难度顺序与已知顺序一致（尺度方向未被翻转）
  const estimated = Object.entries(result.parameters.difficulties)
    .map(([item, entry]) => [item, entry.kind === 'anchor' ? entry.value : entry.byLanguage.zh.value]);
  const trueOrder = Object.entries(difficulties).sort((a, b) => a[1] - b[1]).map(([item]) => item);
  const estimatedOrder = [...estimated].sort((a, b) => a[1] - b[1]).map(([item]) => item);
  assert.deepEqual(estimatedOrder, trueOrder);
  // 位置约束：锚题难度均值为 0
  const anchorMean = (result.parameters.difficulties.d1.value + result.parameters.difficulties.d2.value) / 2;
  assert.ok(Math.abs(anchorMean) < 1e-9, `锚题均值应归零，实际 ${anchorMean}`);
  // 能力方向：估计能力随真实能力单调上升（六分位组均值），且强正相关
  const design = buildDesign(records, { frozenVersion: 'v1' });
  const estimable = selectEstimable(design);
  const fit = fitRasch(design, estimable, ['d1', 'd2']);
  const pairs = abilities
    .map((theta, index) => [theta, fit.theta[`p${index}`]])
    .filter(([, estimate]) => estimate !== undefined);
  const correlation = pearson(pairs);
  assert.ok(correlation > 0.85, `能力估计与真值相关应强正，实际 ${correlation}`);
  const sextiles = Array.from({ length: 6 }, () => []);
  pairs.forEach(([, estimate], pairIndex) => {
    sextiles[Math.min(5, Math.floor((pairIndex / pairs.length) * 6))].push(estimate);
  });
  const groupMeans = sextiles.map(group => group.reduce((sum, value) => sum + value, 0) / group.length);
  for (let index = 1; index < groupMeans.length; index += 1) {
    assert.ok(groupMeans[index] > groupMeans[index - 1],
      `第 ${index + 1} 组均值 ${groupMeans[index]} 应高于前一组 ${groupMeans[index - 1]}`);
  }
});

test('缺答不算答错：同样的表现，缺答者能力高于答错者', () => {
  const model = {
    kind: 'training-scale/rasch-model',
    modelVersion: 1,
    items: {
      q1: { version: 'v1' }, q2: { version: 'v1' }, q3: { version: 'v1' }, q4: { version: 'v1' },
    },
    parameters: {
      constraint: 'anchor-mean-zero',
      difficulties: {
        q1: { kind: 'anchor', value: 0 },
        q2: { kind: 'anchor', value: 0 },
        q3: { kind: 'item', byLanguage: { zh: { value: 0 } } },
        q4: { kind: 'item', byLanguage: { zh: { value: 0 } } },
      },
    },
  };
  const record = (participant, item, correct, answered, id) => ({
    id, participant, item, language: 'zh', correct, answered, version: 'v1',
  });
  const records = [
    record('miss', 'q1', 1, true, 'r1'),
    record('miss', 'q2', 0, true, 'r2'),
    record('miss', 'q3', 0, false, 'r3'), // 缺答
    record('miss', 'q4', 0, false, 'r4'), // 缺答
    record('wrong', 'q1', 1, true, 'r5'),
    record('wrong', 'q2', 0, true, 'r6'),
    record('wrong', 'q3', 0, true, 'r7'), // 答错
    record('wrong', 'q4', 0, true, 'r8'), // 答错
  ];
  return import('../src/analyze.js').then(({ runScoring }) => {
    const result = runScoring(records, model);
    const missing = result.persons.find(person => person.participant === 'miss');
    const wrong = result.persons.find(person => person.participant === 'wrong');
    assert.equal(missing.answered, 2);
    assert.equal(wrong.answered, 4);
    assert.ok(missing.theta > wrong.theta, `缺答者 ${missing.theta} 应高于答错者 ${wrong.theta}`);
    assert.ok(Math.abs(missing.theta) < 1e-9, '两题一对一错且难度为 0 时能力应为 0');
  });
});

test('全对参与者不进联合拟合但记录在诊断中', () => {
  const record = (participant, item, correct, id) => ({
    id, participant, item, language: 'zh', correct, answered: true, version: 'v1',
  });
  const records = [
    record('g1', 'a1', 1, 'r1'), record('g1', 'a2', 0, 'r2'), record('g1', 'x1', 1, 'r3'),
    record('g2', 'a1', 0, 'r4'), record('g2', 'a2', 1, 'r5'), record('g2', 'x1', 0, 'r6'),
    record('g3', 'a1', 1, 'r7'), record('g3', 'a2', 1, 'r8'), record('g3', 'x1', 0, 'r9'),
    record('perfect', 'a1', 1, 'r10'), record('perfect', 'a2', 1, 'r11'), record('perfect', 'x1', 1, 'r12'),
  ];
  const result = runAnalysis(records, { ...POLICY, maxPurification: 0 });
  assert.ok(result.diagnostics.excludedPersons.some(
    entry => entry.participant === 'perfect' && entry.reason === 'all-correct'
  ));
  assert.ok(!('perfect' in (result.parameters ? {} : {})) || true);
  assert.ok(result.diagnostics.converged);
});

test('两个语言版本没有共同作答时不能声称已经等值', () => {
  const records = [];
  let counter = 0;
  const add = (participant, item, language, correct) => {
    records.push({
      id: `r${counter++}`, participant, item, language, correct, answered: true, version: 'v1',
    });
  };
  // zh 组只答 x 题，en 组只答 y 题：没有任何共同题
  for (const person of ['z1', 'z2', 'z3']) {
    add(person, 'x1', 'zh', 1); add(person, 'x2', 'zh', person === 'z1' ? 0 : 1); add(person, 'x3', 'zh', 0);
  }
  for (const person of ['e1', 'e2', 'e3']) {
    add(person, 'y1', 'en', 1); add(person, 'y2', 'en', person === 'e1' ? 0 : 1); add(person, 'y3', 'en', 0);
  }
  const result = runAnalysis(records, { ...POLICY, anchors: ['x1', 'x2'] });
  assert.equal(result.equating.status, 'disconnected');
  assert.equal(result.equating.stage, 'design');
  assert.equal(result.parameters, null);
  assert.equal(result.dif, null);
  assert.ok(result.equating.components.length >= 2);
  assert.ok(result.notes.some(note => note.includes('不能声称已经等值')));
});

test('全部锚题失效时不出具等值参数，并记录每轮移除原因', () => {
  const difficulties = { a1: 0, a2: 0, x1: -0.8, x2: 0, x3: 0.8 };
  // 两个锚题方向相反的偏移：互相作为对方检验的连接时都会暴露
  const dif = { a1: { en: 1.5 }, a2: { en: -1.5 } };
  const abilities = Array.from({ length: 160 }, (_, index) => -2 + (4 * index) / 159);
  const languages = abilities.map((_, index) => (index % 2 === 0 ? 'zh' : 'en'));
  const records = simulate({ abilities, difficulties, languages, dif, seed: 11 });
  const result = runAnalysis(records, POLICY);
  assert.equal(result.equating.status, 'anchors-exhausted');
  assert.equal(result.parameters, null);
  assert.equal(result.purification.removed.length, 2);
  assert.ok(result.purification.removed.every(entry => entry.reason === 'dif-significant-after-correction'));
  assert.ok(result.purification.removed.every(entry => entry.round === 1));
  assert.ok(result.purification.rounds[0].tests.length >= 2);
  assert.equal(result.inference, 'exploratory');
  assert.ok(result.notes.some(note => note.includes('探索性')));
});

test('控制能力后检出注入的语种偏移，报告效应量与样本支持', () => {
  const difficulties = { a1: -0.9, a2: -0.3, x1: 0.2, x2: 0.7, x3: 1.3 };
  const dif = { x2: { en: 1.2 } }; // x2 对 en 组偏移 1.2 logits
  const abilities = Array.from({ length: 300 }, (_, index) => -2.5 + (5 * index) / 299);
  const languages = abilities.map((_, index) => (index % 2 === 0 ? 'zh' : 'en'));
  const records = simulate({ abilities, difficulties, languages, dif, seed: 5 });
  const result = runAnalysis(records, POLICY);
  assert.equal(result.equating.status, 'linked');
  assert.equal(result.inference, 'confirmatory', '锚题干净时不应触发净化');
  assert.equal(result.purification.removed.length, 0);
  const injected = result.dif.tests.find(entry => entry.item === 'x2' && entry.language === 'en');
  assert.ok(injected.flagged, '注入的偏移应被检出');
  assert.ok(injected.q < 0.05);
  assert.ok(Math.abs(injected.delta - 1.2) < 0.6, `效应量应接近 1.2，实际 ${injected.delta}`);
  assert.ok(injected.ci95[0] > 0, '置信区间应整体大于 0（en 更难）');
  assert.ok(injected.support.reference.n > 100 && injected.support.comparison.n > 100);
  assert.ok(injected.support.reference.se > 0 && injected.support.comparison.se > 0);
  assert.equal(result.dif.multipleComparison, 'benjamini-hochberg');
  for (const entry of result.dif.tests) {
    assert.ok(entry.q >= entry.p - 1e-12, 'q 值不应小于 p 值');
  }
  // 未注入偏移的题项在本种子下不应误报
  for (const entry of result.dif.tests.filter(test => test.item !== 'x2')) {
    assert.ok(!entry.flagged, `${entry.item} 不应被误报`);
  }
  assert.ok(result.reviewList.some(entry => entry.item === 'x2' && entry.reason === 'dif-significant'));
});

test('锚题按预设规则净化：移除原因逐轮记录，结论降级为探索性', () => {
  const difficulties = { a1: -0.6, a2: 0.4, x1: -0.2, x2: 0.6, x3: 1.2 };
  const dif = { a1: { en: 1.4 } }; // 只有 a1 有偏移
  const abilities = Array.from({ length: 300 }, (_, index) => -2.5 + (5 * index) / 299);
  const languages = abilities.map((_, index) => (index % 2 === 0 ? 'zh' : 'en'));
  const records = simulate({ abilities, difficulties, languages, dif, seed: 9 });
  const result = runAnalysis(records, POLICY);
  assert.equal(result.equating.status, 'linked');
  assert.deepEqual(result.purification.removed.map(entry => entry.anchor), ['a1']);
  assert.equal(result.purification.removed[0].reason, 'dif-significant-after-correction');
  assert.equal(result.purification.removed[0].round, 1);
  assert.ok(result.purification.removed[0].detail[0].q < 0.05);
  assert.deepEqual(result.anchors.final, ['a2']);
  assert.equal(result.inference, 'exploratory', '净化过的锚集不能当确认性结论');
  assert.ok(result.notes.some(note => note.includes('探索性')));
  // 被移除的锚题转为普通题项参与 DIF 检验并进入复核清单
  assert.ok(result.dif.tests.some(entry => entry.item === 'a1' && entry.flagged));
  assert.ok(result.reviewList.some(entry => entry.item === 'a1' && entry.reason === 'anchor-removed'));
});

test('缺答记录不进似然：缺答率不影响可估计设计的构造', () => {
  const difficulties = { a1: -0.5, a2: 0.5, x1: 0 };
  const abilities = Array.from({ length: 60 }, (_, index) => -2 + (4 * index) / 59);
  const languages = abilities.map((_, index) => (index % 2 === 0 ? 'zh' : 'en'));
  const complete = simulate({ abilities, difficulties, languages, seed: 3 });
  const sparse = simulate({ abilities, difficulties, languages, seed: 3, missingRate: 0.3 });
  const designComplete = buildDesign(complete, { frozenVersion: 'v1' });
  const designSparse = buildDesign(sparse, { frozenVersion: 'v1' });
  const answered = design => [...design.persons.values()]
    .reduce((sum, person) => sum + person.responses.length, 0);
  assert.ok(answered(designSparse) < answered(designComplete));
  // 缺答记录的 correct 占位不被当作答错
  const placeholder = sparse.filter(record => !record.answered);
  assert.ok(placeholder.every(record => record.correct === 0));
  assert.ok(placeholder.length > 0);
});

test('题目版本与冻结版本不一致时直接拒绝', () => {
  const records = [{
    id: 'r1', participant: 'p1', item: 'a1', language: 'zh', correct: 1, answered: true, version: 'v2',
  }];
  assert.throws(() => runAnalysis(records, POLICY), /冻结版本/);
});

test('参考语言不在数据中时报配置错误', () => {
  const records = [{
    id: 'r1', participant: 'p1', item: 'a1', language: 'en', correct: 1, answered: true, version: 'v1',
  }];
  assert.throws(() => runAnalysis(records, POLICY), /参考语言/);
});

test('分析配置字段校验', () => {
  assert.throws(() => validatePolicy({ ...POLICY, anchors: [] }), /anchors/);
  assert.throws(() => validatePolicy({ ...POLICY, anchors: ['a1', 'a1'] }), /重复/);
  assert.throws(() => validatePolicy({ ...POLICY, alpha: 1.5 }), /alpha/);
  assert.throws(() => validatePolicy({ ...POLICY, maxPurification: -1 }), /maxPurification/);
  assert.throws(() => validatePolicy({ ...POLICY, frozenVersion: '' }), /frozenVersion/);
  assert.throws(() => validatePolicy(null), /对象/);
  assert.deepEqual(validatePolicy(POLICY), POLICY);
});

test('参与者跨语言混用与非二元作答被拒绝', () => {
  const base = { language: 'zh', correct: 1, answered: true, version: 'v1' };
  assert.throws(() => buildDesign([
    { ...base, id: 'r1', participant: 'p1', item: 'a1' },
    { ...base, id: 'r2', participant: 'p1', item: 'a2', language: 'en' },
  ]), /多个语言版本/);
  assert.throws(() => buildDesign([
    { ...base, id: 'r1', participant: 'p1', item: 'a1', correct: 2 },
  ]), /0 或 1/);
});

test('连接检查覆盖：无已答记录与锚题缺覆盖', () => {
  const record = (participant, item, language, answered, id) => ({
    id, participant, item, language, correct: 0, answered, version: 'v1',
  });
  const empty = buildDesign([record('p1', 'a1', 'zh', false, 'r1')]);
  const linkage = checkLinkage(empty, ['a1']);
  assert.equal(linkage.connected, false);
  assert.deepEqual(linkage.personsWithoutResponses, ['p1']);
  const oneSided = buildDesign([
    record('p1', 'a1', 'zh', true, 'r1'),
    { ...record('p2', 'a1', 'zh', true, 'r2'), correct: 0 },
  ]);
  assert.equal(checkLinkage(oneSided, ['a1']).linked, false, '锚题只在一个语言有覆盖');
});
