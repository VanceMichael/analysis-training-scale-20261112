import { main } from '../src/cli.js';
import { readFile } from 'node:fs/promises';
import { writeResult } from '../src/output.js';

const started = performance.now();
console.log('读取本地演练记录并核对输入指纹');
console.log(JSON.stringify(await main(['inspect']), null, 2));
console.log('现有领域核算（答对率清点，保留不变）');
console.log(JSON.stringify(await main(['summary', '--out', 'var/summary.json']), null, 2));
console.log('业务配置');
const policy = JSON.parse(await readFile('data/policy.json', 'utf8'));
console.log(JSON.stringify(policy, null, 2));

console.log('对演练数据做 Rasch 联合拟合（data/records.json）');
const drill = await main(['analyze', '--out', 'var/model-drill.json']);
console.log(`等值状态：${drill.equating.status}（${drill.notes[0] ?? '无附加说明'}）`);
console.log(`复核清单条目：${drill.reviewList.length}；是否出具参数：${drill.parameters ? '是' : '否'}`);

// 演练数据的两个版本在剔除极端单元格后断连，无法演示完整等值；
// 另合成一份可等值的两语言数据（种子固定、难度已知）演示完整流程
console.log('合成可等值两语言数据演示完整流程（种子固定，q3 对 en 组偏移 1.5）');
const random = (() => {
  let seed = 20261114;
  return () => {
    seed += 0x6D2B79F5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();
const logistic = value => 1 / (1 + Math.exp(-value));
const difficulties = { q1: -1.1, q2: -0.4, q3: 0.1, q4: 0.6, q5: 1.1, q6: 1.6 };
const dif = { q3: { en: 1.5 } };
const records = [];
let counter = 0;
for (let index = 0; index < 240; index += 1) {
  const theta = -2.2 + (4.4 * index) / 239;
  const language = index % 2 === 0 ? 'zh' : 'en';
  for (const [item, base] of Object.entries(difficulties)) {
    const answered = random() >= 0.05; // 5% 缺答
    const shift = dif[item]?.[language] ?? 0;
    records.push({
      id: `d${String(counter).padStart(5, '0')}`,
      participant: `v${index}`,
      item,
      language,
      correct: answered && random() < logistic(theta - base - shift) ? 1 : 0,
      answered,
      version: 'v1',
    });
    counter += 1;
  }
}
await writeResult('var/demo-records.json', { version: 1, records });
const model = await main(['analyze', '--input', 'var/demo-records.json', '--out', 'var/model.json']);
console.log(`等值状态：${model.equating.status}；收敛：${model.diagnostics.converged}；推断性质：${model.inference}`);
console.log('DIF 检验（效应量 / 95% CI / q 值 / 样本量）：');
for (const test of model.dif.tests) {
  console.log(`  ${test.item} (${test.language}) Δ=${test.delta.toFixed(2)} CI=[${test.ci95.map(v => v.toFixed(2)).join(',')}] q=${test.q.toFixed(3)} n=${test.support.reference.n}+${test.support.comparison.n}${test.flagged ? ' ← 需复核' : ''}`);
}
console.log(`复核清单条目：${model.reviewList.length}`);

console.log('新增批次只做能力评分（档案难度冻结，含缺答、全对与版本不符）');
const batch = { version: 1, records: [] };
const batchSpec = [
  ['w0', [1, 0, 1, 0, 1, 0]],
  ['w1', [1, 1, 1, 1, 1, 1]], // 全对：能力无界
  ['w2', [1, null, 0, null, 1, 0]], // 含缺答
];
batchSpec.forEach(([participant, pattern], personIndex) => {
  Object.keys(difficulties).forEach((item, itemIndex) => {
    const correct = pattern[itemIndex];
    batch.records.push({
      id: `b${personIndex}${itemIndex}`,
      participant,
      item,
      language: personIndex === 1 ? 'en' : 'zh',
      correct: correct ?? 0,
      answered: correct !== null,
      version: 'v1',
    });
  });
});
batch.records.push({
  id: 'b90', participant: 'w3', item: 'q1', language: 'zh', correct: 1, answered: true, version: 'v2', // 版本不符
});
await writeResult('var/batch.json', batch);
const scores = await main(['score', '--input', 'var/batch.json', '--model', 'var/model.json', '--out', 'var/scores.json']);
for (const person of scores.persons) {
  const theta = person.theta === null ? `无界（${person.extreme ?? person.reason}）` : person.theta.toFixed(2);
  const excluded = person.excluded.length ? `；排除：${person.excluded.map(entry => `${entry.item}(${entry.reason})`).join('、')}` : '';
  console.log(`  ${person.participant} [${person.language}] θ=${theta}${excluded}`);
}
console.log(`完成，用时 ${Math.ceil(performance.now() - started)} 毫秒`);
