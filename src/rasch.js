// 二元 Rasch 模型的联合极大似然拟合、连接检查、语言 DIF 检验与锚题净化。
// 本模块只有纯函数：文件读写、配置解析与命令行装配在 analyze.js / cli.js。
//
// 口径约定（详见 docs/rasch.md）：
// - answered=false 的记录不进入似然，缺答不算答错；
// - 位置约束：每轮迭代后强制锚题难度均值为 0，能力与全部难度同步平移；
// - 全对/全错的参与者与题目×语言单元格的似然无界，估计前迭代剔除并记录；
// - 锚题共享一个难度参数，把两个语言版本连接到同一把尺上。

const STEP_LIMIT = 3; // 单次牛顿步长上限，避免极端起点下发散
const TOLERANCE = 1e-6;
const MAX_ITERATIONS = 300;
const MIN_PROBABILITY = 1e-9;
const SEP = ''; // 单元格键的分隔符，题目名与语言名中不可出现

export function logistic(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const factor = Math.exp(value);
  return factor / (1 + factor);
}

// Abramowitz–Stegun 7.1.26 误差函数近似，供 Wald 检验的正态 p 值使用。
function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const absolute = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * absolute);
  const polynomial = t * (0.254829592 + t * (-0.284496736
    + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - polynomial * Math.exp(-absolute * absolute));
}

export function normalCdf(value) {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

// Benjamini–Hochberg：同一批检验统一校正，返回与输入同序的 q 值。
export function benjaminiHochberg(pvalues) {
  const size = pvalues.length;
  const order = pvalues.map((p, index) => [p, index]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const adjusted = new Array(size).fill(1);
  let running = 1;
  for (let rank = size; rank >= 1; rank -= 1) {
    const [p, index] = order[rank - 1];
    running = Math.min(running, (p * size) / rank);
    adjusted[index] = Math.min(1, running);
  }
  return adjusted;
}

const byKey = (left, right) => left.localeCompare(right, 'en');
const cellKey = (item, language) => `${item}${SEP}${language}`;
const splitCellKey = key => key.split(SEP);

// 把记录整理成分析用结构。只读，不改写输入。
// options.frozenVersion 提供时，要求每条记录的题目版本与之一致（校准口径）；
// 不提供时（评分口径）版本逐条记录保留，由调用方与模型档案核对。
export function buildDesign(records, options = {}) {
  const persons = new Map();
  const items = new Map();
  for (const record of records) {
    if (options.frozenVersion !== undefined && record.version !== options.frozenVersion) {
      throw new Error(`记录 ${record.id} 的题目版本 ${record.version} 与冻结版本 ${options.frozenVersion} 不一致`);
    }
    let person = persons.get(record.participant);
    if (!person) {
      person = { language: record.language, responses: [] };
      persons.set(record.participant, person);
    }
    if (person.language !== record.language) {
      throw new Error(`参与者 ${record.participant} 同时出现在多个语言版本中`);
    }
    let item = items.get(record.item);
    if (!item) {
      item = { versions: new Set(), cells: new Map() };
      items.set(record.item, item);
    }
    item.versions.add(record.version);
    if (!record.answered) continue; // 缺答：不进似然，也不算答错
    if (record.correct !== 0 && record.correct !== 1) {
      throw new Error(`记录 ${record.id} 的 correct 应为 0 或 1`);
    }
    if (person.responses.some(response => response.item === record.item)) {
      throw new Error(`参与者 ${record.participant} 对题目 ${record.item} 有重复作答记录`);
    }
    person.responses.push({ item: record.item, correct: record.correct, version: record.version });
    let cell = item.cells.get(record.language);
    if (!cell) {
      cell = { n: 0, sum: 0 };
      item.cells.set(record.language, cell);
    }
    cell.n += 1;
    cell.sum += record.correct;
  }
  const languages = [...new Set([...persons.values()].map(person => person.language))].sort(byKey);
  return { persons, items, languages };
}

// 参与者—题项二部图连通性与锚题覆盖。断开的版本不能声称已经等值。
// 提供 estimable 时，只在剔除极端分后的可估计子设计上检查：
// 原始设计连通不代表剔除极端单元格后仍然连通。
export function checkLinkage(design, anchors, estimable = null) {
  const parent = new Map();
  const find = node => {
    let root = node;
    while (parent.get(root) !== root) root = parent.get(root);
    let current = node;
    while (parent.get(current) !== current) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (left, right) => {
    if (!parent.has(left)) parent.set(left, left);
    if (!parent.has(right)) parent.set(right, right);
    const rootLeft = find(left);
    const rootRight = find(right);
    if (rootLeft !== rootRight) parent.set(rootLeft, rootRight);
  };
  const personsWithoutResponses = [];
  for (const [id, person] of [...design.persons.entries()].sort(([a], [b]) => byKey(a, b))) {
    if (estimable && !estimable.activePersons.has(id)) continue;
    const responses = estimable
      ? person.responses.filter(response => estimable.activeCells.has(cellKey(response.item, person.language)))
      : person.responses;
    if (responses.length === 0) {
      personsWithoutResponses.push(id);
      continue;
    }
    for (const response of responses) union(`p:${id}`, `i:${response.item}`);
  }
  const groups = new Map();
  for (const node of parent.keys()) {
    const root = find(node);
    if (!groups.has(root)) groups.set(root, { persons: [], items: [] });
    const group = groups.get(root);
    if (node.startsWith('p:')) group.persons.push(node.slice(2));
    else group.items.push(node.slice(2));
  }
  const components = [...groups.values()]
    .map(group => ({ persons: group.persons.sort(byKey), items: group.items.sort(byKey) }))
    .sort((a, b) => byKey(a.items[0] ?? a.persons[0], b.items[0] ?? b.persons[0]));
  const anchorCoverage = anchors.map(anchor => {
    const item = design.items.get(anchor);
    const byLanguage = {};
    if (item) {
      for (const [language, cell] of [...item.cells.entries()].sort(([a], [b]) => byKey(a, b))) {
        if (estimable && !estimable.activeCells.has(cellKey(anchor, language))) continue;
        byLanguage[language] = cell.n;
      }
    }
    return { anchor, byLanguage, coveredLanguages: Object.keys(byLanguage).length };
  });
  const connected = parent.size > 0 && components.length <= 1;
  const linked = anchorCoverage.some(entry => entry.coveredLanguages >= 2);
  const reasons = [];
  if (parent.size === 0) reasons.push('没有任何已答记录');
  else if (!connected) reasons.push(`参与者—题项图分为 ${components.length} 个不连通部分`);
  if (!linked) reasons.push('没有锚题在两种及以上语言中都有已答覆盖');
  return { connected, linked, components, anchorCoverage, personsWithoutResponses, reasons };
}

// 迭代剔除极端分：在当前可估计集合上全对/全错的参与者、
// 以及全对/全错/无人的题目×语言单元格。剔除理由逐条记录。
export function selectEstimable(design) {
  const excludedPersons = [];
  const excludedCells = [];
  const activePersons = new Set([...design.persons.keys()].sort(byKey));
  for (const id of [...activePersons]) {
    if (design.persons.get(id).responses.length === 0) {
      activePersons.delete(id);
      excludedPersons.push({ participant: id, reason: 'no-responses' });
    }
  }
  const activeCells = new Set();
  for (const [item, entry] of design.items) {
    for (const language of entry.cells.keys()) activeCells.add(cellKey(item, language));
  }
  for (let sweep = 0; sweep < 25; sweep += 1) {
    let changed = false;
    for (const id of [...activePersons].sort(byKey)) {
      const person = design.persons.get(id);
      const responses = person.responses.filter(
        response => activeCells.has(cellKey(response.item, person.language))
      );
      if (responses.length === 0) {
        activePersons.delete(id);
        excludedPersons.push({ participant: id, reason: 'no-estimable-items' });
        changed = true;
        continue;
      }
      const sum = responses.reduce((total, response) => total + response.correct, 0);
      if (sum === responses.length) {
        activePersons.delete(id);
        excludedPersons.push({ participant: id, reason: 'all-correct' });
        changed = true;
      } else if (sum === 0) {
        activePersons.delete(id);
        excludedPersons.push({ participant: id, reason: 'all-wrong' });
        changed = true;
      }
    }
    if (changed) continue;
    const stats = new Map();
    for (const id of activePersons) {
      const person = design.persons.get(id);
      for (const response of person.responses) {
        const key = cellKey(response.item, person.language);
        if (!activeCells.has(key)) continue;
        if (!stats.has(key)) stats.set(key, { n: 0, sum: 0 });
        const cell = stats.get(key);
        cell.n += 1;
        cell.sum += response.correct;
      }
    }
    for (const key of [...activeCells].sort(byKey)) {
      const cell = stats.get(key);
      const [item, language] = splitCellKey(key);
      if (!cell || cell.n === 0) {
        activeCells.delete(key);
        excludedCells.push({ item, language, reason: 'no-responses' });
        changed = true;
      } else if (cell.sum === cell.n) {
        activeCells.delete(key);
        excludedCells.push({ item, language, reason: 'all-correct' });
        changed = true;
      } else if (cell.sum === 0) {
        activeCells.delete(key);
        excludedCells.push({ item, language, reason: 'all-wrong' });
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { activePersons, activeCells, excludedPersons, excludedCells };
}

function logAddExp(left, right) {
  if (left === -Infinity) return right;
  if (right === -Infinity) return left;
  return left > right
    ? left + Math.log1p(Math.exp(right - left))
    : right + Math.log1p(Math.exp(left - right));
}

// 高斯-若尔当求逆（部分主元）。矩阵奇异时抛出明确错误。
function invertMatrix(matrix) {
  const size = matrix.length;
  const augmented = matrix.map((row, index) => [
    ...row,
    ...Array.from({ length: size }, (_, column) => (column === index ? 1 : 0)),
  ]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) {
      throw new Error('信息矩阵奇异，当前设计下参数不可识别');
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let entry = 0; entry < 2 * size; entry += 1) augmented[column][entry] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      if (factor === 0) continue;
      for (let entry = 0; entry < 2 * size; entry += 1) {
        augmented[row][entry] -= factor * augmented[column][entry];
      }
    }
  }
  return augmented.map(row => row.slice(size));
}

// 前/后缀基本对称函数（对数空间 DP）：prefix[j][t] 为前 j 个元素的 t 阶对称函数对数
function symmetricTables(logEpsilons, maxOrder) {
  const count = logEpsilons.length;
  const prefix = Array.from({ length: count + 1 }, () => new Array(maxOrder + 1).fill(-Infinity));
  prefix[0][0] = 0;
  for (let j = 1; j <= count; j += 1) {
    prefix[j][0] = 0;
    for (let t = 1; t <= Math.min(j, maxOrder); t += 1) {
      prefix[j][t] = logAddExp(prefix[j - 1][t], prefix[j - 1][t - 1] + logEpsilons[j - 1]);
    }
  }
  const suffix = Array.from({ length: count + 1 }, () => new Array(maxOrder + 1).fill(-Infinity));
  suffix[count][0] = 0;
  for (let j = count - 1; j >= 0; j -= 1) {
    suffix[j][0] = 0;
    for (let t = 1; t <= Math.min(count - j, maxOrder); t += 1) {
      suffix[j][t] = logAddExp(suffix[j + 1][t], suffix[j + 1][t - 1] + logEpsilons[j]);
    }
  }
  return { prefix, suffix };
}

// log γ_t(J \ 第 skip 个元素)，由前/后缀表合并
function logGammaWithout(prefix, suffix, position, order) {
  if (order < 0) return -Infinity;
  let result = -Infinity;
  for (let u = 0; u <= order; u += 1) {
    result = logAddExp(result, prefix[position][u] + suffix[position + 1][order - u]);
  }
  return result;
}

// 联合拟合：两个语言版本在同一估计中校准到同一把尺上。
// 题目难度用条件极大似然（CML，对每人总分条件化，消去能力偶然参数，
// 避免短卷下联合极大似然的系统性偏差）；能力在难度给定后用普通极大似然估计。
// 位置约束：锚题难度均值固定为 0。anchorSet 为空时无法定位尺度，调用方必须先保证非空。
export function fitRasch(design, estimable, anchorSet, options = {}) {
  const tolerance = options.tolerance ?? TOLERANCE;
  const maxIterations = options.maxIterations ?? MAX_ITERATIONS;
  const anchors = new Set(anchorSet);
  const persons = [...estimable.activePersons].sort(byKey);

  const keyFor = (item, language) => (anchors.has(item) ? `a${SEP}${item}` : `c${SEP}${item}${SEP}${language}`);
  const personResponses = persons.map(id => {
    const person = design.persons.get(id);
    return person.responses
      .filter(response => estimable.activeCells.has(cellKey(response.item, person.language)))
      .map(response => ({ key: keyFor(response.item, person.language), correct: response.correct }));
  });
  const keySet = new Set();
  for (const responses of personResponses) for (const response of responses) keySet.add(response.key);
  for (const anchor of anchors) {
    if (!keySet.has(`a${SEP}${anchor}`)) throw new Error(`锚题 ${anchor} 没有可估计的已答记录`);
  }
  const keys = [...keySet].sort(byKey);
  const keyIndex = new Map(keys.map((key, index) => [key, index]));
  const size = keys.length;

  // 条件似然按 （作答键集合， 总分） 分组：同组人员的条件分布相同
  const groups = new Map();
  personResponses.forEach(responses => {
    if (responses.length === 0) return;
    const score = responses.reduce((total, response) => total + response.correct, 0);
    if (score === 0 || score === responses.length) return; // 极端分对条件似然无贡献
    const signature = responses.map(response => response.key).sort(byKey).join(SEP) + `#${score}`;
    if (!groups.has(signature)) {
      groups.set(signature, {
        indexes: [...new Set(responses.map(response => response.key))].sort(byKey).map(key => keyIndex.get(key)),
        score,
        weight: 0,
        totals: new Float64Array(size),
      });
    }
    const group = groups.get(signature);
    group.weight += 1;
    for (const response of responses) group.totals[keyIndex.get(response.key)] += response.correct;
  });
  const groupList = [...groups.values()];

  const difficulties = new Float64Array(size);
  // 在给定难度处计算条件似然的得分向量与期望信息矩阵
  const computeDerivatives = () => {
    const gradient = new Float64Array(size);
    const information = Array.from({ length: size }, () => new Float64Array(size));
    for (const group of groupList) {
      const logEpsilons = group.indexes.map(index => -difficulties[index]);
      const { prefix, suffix } = symmetricTables(logEpsilons, group.score);
      const logGamma = prefix[group.indexes.length][group.score];
      const expected = group.indexes.map((_, position) => Math.exp(
        logEpsilons[position] + logGammaWithout(prefix, suffix, position, group.score - 1) - logGamma
      ));
      // 每个位置的留一表，用于配对项 γ(J\{a,b\})
      const leaveOne = group.indexes.map((_, position) => {
        const rest = logEpsilons.filter((_, index) => index !== position);
        return symmetricTables(rest, group.score);
      });
      for (let a = 0; a < group.indexes.length; a += 1) {
        const indexA = group.indexes[a];
        // totals 已是全组求和（含权重），只有期望项按组人数加权
        gradient[indexA] += group.weight * expected[a] - group.totals[indexA];
        information[indexA][indexA] += group.weight * expected[a] * (1 - expected[a]);
        for (let b = a + 1; b < group.indexes.length; b += 1) {
          const indexB = group.indexes[b];
          // 在 J\{a} 中 b 的位置为 b-1，再排除它得到 γ(J\{a,b\})
          const joint = Math.exp(logEpsilons[a] + logEpsilons[b]
            + logGammaWithout(leaveOne[a].prefix, leaveOne[a].suffix, b - 1, group.score - 2)
            - logGamma);
          const covariance = joint - expected[a] * expected[b];
          information[indexA][indexB] += group.weight * covariance;
          information[indexB][indexA] += group.weight * covariance;
        }
      }
    }
    return { gradient, information };
  };

  const unit = 1 / Math.sqrt(size);
  let iterations = 0;
  let maxChange = Infinity;
  let converged = false;
  for (iterations = 1; iterations <= maxIterations; iterations += 1) {
    const { gradient, information } = computeDerivatives();
    // 约束方向 u（全参数同步平移）使信息矩阵秩亏一；加 uuᵀ 正则化后求解，
    // 得分与 u 正交，解自动满足约束
    const regularized = information.map((row, a) => row.map((value, b) => value + unit * unit));
    const inverse = invertMatrix(regularized);
    maxChange = 0;
    for (let a = 0; a < size; a += 1) {
      let step = 0;
      for (let b = 0; b < size; b += 1) step += inverse[a][b] * gradient[b];
      step = Math.max(-STEP_LIMIT, Math.min(STEP_LIMIT, step));
      difficulties[a] += step;
      if (Math.abs(step) > maxChange) maxChange = Math.abs(step);
    }
    // 位置约束：锚题难度均值固定为 0（沿 u 方向归位，数值上兜底）
    let mean = 0;
    let anchorCount = 0;
    for (let a = 0; a < size; a += 1) {
      if (keys[a].startsWith(`a${SEP}`)) {
        mean += difficulties[a];
        anchorCount += 1;
      }
    }
    mean /= anchorCount;
    for (let a = 0; a < size; a += 1) difficulties[a] -= mean;
    if (maxChange < tolerance) {
      converged = true;
      break;
    }
  }

  // 在最终参数处重算信息矩阵；约束下的协方差：I⁺ = (I + uuᵀ)⁻¹ − uuᵀ
  const finalDerivatives = computeDerivatives();
  const information = finalDerivatives.information;
  const regularized = information.map((row, a) => row.map((value, b) => value + unit * unit));
  const inverse = invertMatrix(regularized);
  const covariance = inverse.map((row, a) => row.map((value, b) => value - unit * unit));

  // 条件对数似然（诊断用）
  let conditionalLogLikelihood = 0;
  for (const group of groupList) {
    const logEpsilons = group.indexes.map(index => -difficulties[index]);
    const { prefix } = symmetricTables(logEpsilons, group.score);
    let kernel = 0;
    for (const index of group.indexes) kernel -= group.totals[index] * difficulties[index];
    conditionalLogLikelihood += kernel - group.weight * prefix[group.indexes.length][group.score];
  }

  // 能力：难度给定后的普通极大似然
  const theta = {};
  for (const [personIndex, id] of persons.entries()) {
    const responses = personResponses[personIndex];
    if (responses.length === 0) continue;
    const score = responses.reduce((total, response) => total + response.correct, 0);
    if (score === 0 || score === responses.length) continue; // 极端分能力无界
    let estimate = Math.log((score + 0.5) / (responses.length - score + 0.5));
    for (let iteration = 0; iteration < 100; iteration += 1) {
      let gradientP = 0;
      let informationP = 0;
      for (const response of responses) {
        const probability = Math.min(1 - MIN_PROBABILITY, Math.max(MIN_PROBABILITY,
          logistic(estimate - difficulties[keyIndex.get(response.key)])));
        gradientP += response.correct - probability;
        informationP += probability * (1 - probability);
      }
      const step = Math.max(-STEP_LIMIT, Math.min(STEP_LIMIT, gradientP / informationP));
      estimate += step;
      if (Math.abs(step) < 1e-8) break;
    }
    theta[id] = estimate;
  }

  const counts = new Float64Array(size);
  for (const responses of personResponses) {
    for (const response of responses) counts[keyIndex.get(response.key)] += 1;
  }
  const keyStats = Object.fromEntries(keys.map((key, index) => [key, {
    value: difficulties[index],
    se: Math.sqrt(Math.max(covariance[index][index], 0)),
    information: information[index][index],
    n: counts[index],
  }]));
  const covarianceOf = (keyA, keyB) => covariance[keyIndex.get(keyA)][keyIndex.get(keyB)];

  const structured = {};
  for (const [item, entry] of [...design.items.entries()].sort(([a], [b]) => byKey(a, b))) {
    if (anchors.has(item)) {
      const stats = keyStats[`a${SEP}${item}`];
      if (stats) structured[item] = { kind: 'anchor', value: stats.value, se: stats.se, n: stats.n };
    } else {
      const byLanguage = {};
      for (const language of [...entry.cells.keys()].sort(byKey)) {
        const stats = keyStats[`c${SEP}${item}${SEP}${language}`];
        if (stats) byLanguage[language] = { value: stats.value, se: stats.se, n: stats.n };
      }
      if (Object.keys(byLanguage).length) structured[item] = { kind: 'item', byLanguage };
    }
  }
  return {
    difficulties: structured,
    theta,
    keyStats,
    covarianceOf,
    diagnostics: {
      estimator: 'cml-items+ml-abilities',
      iterations,
      converged,
      maxChange,
      conditionalLogLikelihood,
      persons: persons.length,
      responses: counts.reduce((total, count) => total + count, 0),
      constraint: 'anchor-mean-zero',
      anchors: [...anchors].sort(byKey),
    },
  };
}

// 语言 DIF：联合拟合后比较非锚题的语种偏移，同批题项统一 BH 校正。
// Δ 的方差来自约束下完整协方差矩阵（含两单元格的协方差项）。
// 报告效应量、置信区间与样本支持，不只贴显著星号。
export function difTests(fit, design, referenceLanguage, alpha) {
  const tests = [];
  const untestable = [];
  const others = design.languages.filter(language => language !== referenceLanguage);
  for (const [item, entry] of Object.entries(fit.difficulties).sort(([a], [b]) => byKey(a, b))) {
    if (entry.kind !== 'item') continue;
    for (const language of others) {
      const reference = entry.byLanguage[referenceLanguage];
      const comparison = entry.byLanguage[language];
      if (!reference || !comparison) {
        const itemEntry = design.items.get(item);
        const missing = !itemEntry?.cells.has(referenceLanguage) || !itemEntry?.cells.has(language);
        untestable.push({ item, language, reason: missing ? 'cell-missing' : 'cell-extreme' });
        continue;
      }
      const referenceKey = `c${SEP}${item}${SEP}${referenceLanguage}`;
      const comparisonKey = `c${SEP}${item}${SEP}${language}`;
      const delta = comparison.value - reference.value;
      const variance = fit.covarianceOf(referenceKey, referenceKey)
        + fit.covarianceOf(comparisonKey, comparisonKey)
        - 2 * fit.covarianceOf(referenceKey, comparisonKey);
      const se = Math.sqrt(Math.max(variance, 0));
      const z = delta / se;
      const p = 2 * (1 - normalCdf(Math.abs(z)));
      tests.push({
        item,
        language,
        delta,
        se,
        z,
        p,
        ci95: [delta - 1.959964 * se, delta + 1.959964 * se],
        support: {
          reference: { language: referenceLanguage, n: reference.n, se: reference.se },
          comparison: { language, n: comparison.n, se: comparison.se },
        },
      });
    }
  }
  const adjusted = benjaminiHochberg(tests.map(test => test.p));
  tests.forEach((test, index) => {
    test.q = adjusted[index];
    test.flagged = test.q < alpha;
    const magnitude = Math.abs(test.delta);
    test.etsClass = magnitude < 0.43 ? 'A' : magnitude < 0.64 ? 'B' : 'C';
  });
  tests.sort((a, b) => byKey(a.item, b.item) || byKey(a.language, b.language));
  untestable.sort((a, b) => byKey(a.item, b.item) || byKey(a.language, b.language));
  return { referenceLanguage, multipleComparison: 'benjamini-hochberg', alpha, tests, untestable };
}

// 锚题净化，规则预先给定、不随数据调整：
// 每轮把当前锚集中每个锚题单独释放，以“其余锚题 + 全部未移除题项”的共识为连接
// 重新联合拟合（只用其余锚题作连接时，两个锚题会精确互相混叠，无法分辨谁有偏）；
// 轮内对全部 锚题×语种 检验做 BH 校正，q < alpha 的锚题本轮全部移除并记录原因；
// 被移除的锚题退出后续轮次的链接池；最多 maxPurification 轮。
// 锚集耗尽或达到轮次上限都不得再声称等值稳定。
export function purifyAnchors(design, estimable, anchors, policy, options = {}) {
  const rounds = [];
  const removed = [];
  let current = [...anchors];
  if (policy.maxPurification === 0) {
    return { status: 'disabled', rounds, removed, finalAnchors: current };
  }
  const activeItems = new Set([...estimable.activeCells].map(key => key.split(SEP)[0]));
  let status = 'stable';
  for (let round = 1; round <= policy.maxPurification; round += 1) {
    if (current.length < 2) {
      status = current.length === 0 ? 'anchors-exhausted' : 'too-few-to-test';
      break;
    }
    // 链接池：当前锚集与未移除的全部可估计题项；已移除锚题不再参与连接
    const removedSet = new Set(removed.map(entry => entry.anchor));
    const linkPool = [...activeItems].filter(item => !removedSet.has(item)).sort(byKey);
    const tests = [];
    const notes = [];
    for (const anchor of current) {
      const link = linkPool.filter(item => item !== anchor);
      const fit = fitRasch(design, estimable, link, options);
      const entry = fit.difficulties[anchor];
      if (!entry || entry.kind !== 'item') {
        notes.push({ anchor, note: '释放后的锚题无法估计，本轮跳过' });
        continue;
      }
      for (const language of design.languages.filter(candidate => candidate !== policy.referenceLanguage)) {
        const reference = entry.byLanguage[policy.referenceLanguage];
        const comparison = entry.byLanguage[language];
        if (!reference || !comparison) {
          notes.push({ anchor, language, note: '单元格缺失或极端，无法检验' });
          continue;
        }
        const referenceKey = `c${SEP}${anchor}${SEP}${policy.referenceLanguage}`;
        const comparisonKey = `c${SEP}${anchor}${SEP}${language}`;
        const delta = comparison.value - reference.value;
        const variance = fit.covarianceOf(referenceKey, referenceKey)
          + fit.covarianceOf(comparisonKey, comparisonKey)
          - 2 * fit.covarianceOf(referenceKey, comparisonKey);
        const se = Math.sqrt(Math.max(variance, 0));
        const z = delta / se;
        tests.push({ anchor, language, delta, se, z, p: 2 * (1 - normalCdf(Math.abs(z))) });
      }
    }
    const adjusted = benjaminiHochberg(tests.map(test => test.p));
    tests.forEach((test, index) => {
      test.q = adjusted[index];
      test.flagged = test.q < policy.alpha;
    });
    const flagged = [...new Set(tests.filter(test => test.flagged).map(test => test.anchor))].sort(byKey);
    const removedThisRound = flagged.map(anchor => ({
      anchor,
      round,
      reason: 'dif-significant-after-correction',
      detail: tests.filter(test => test.anchor === anchor && test.flagged)
        .map(test => ({ language: test.language, delta: test.delta, q: test.q })),
    }));
    rounds.push({ round, anchorsBefore: [...current], linkPool, tests, notes, removed: removedThisRound });
    removed.push(...removedThisRound);
    if (flagged.length === 0) {
      status = 'stable';
      break;
    }
    current = current.filter(anchor => !flagged.includes(anchor));
    if (current.length === 0) {
      status = 'anchors-exhausted';
      break;
    }
    if (round === policy.maxPurification) status = 'round-limit-reached';
  }
  return { status, rounds, removed, finalAnchors: current };
}

// 冻结评分：只使用档案中已发布的难度估计能力，不重新拟合题目参数。
export function scorePersons(design, model) {
  const difficultyFor = (item, language) => {
    const entry = model.parameters.difficulties[item];
    if (!entry) return undefined;
    if (entry.kind === 'anchor') return entry.value;
    const cell = entry.byLanguage?.[language];
    if (cell === undefined) return undefined;
    return typeof cell === 'number' ? cell : cell.value;
  };
  const results = [];
  for (const [id, person] of [...design.persons.entries()].sort(([a], [b]) => byKey(a, b))) {
    const used = [];
    const excluded = [];
    for (const response of person.responses) {
      const registered = model.items[response.item];
      if (!registered) {
        excluded.push({ item: response.item, reason: 'unknown-item' });
        continue;
      }
      if (response.version !== registered.version) {
        excluded.push({
          item: response.item,
          reason: 'version-mismatch',
          detail: `批次版本 ${response.version}，已发布版本 ${registered.version}`,
        });
        continue;
      }
      const difficulty = difficultyFor(response.item, person.language);
      if (difficulty === undefined) {
        excluded.push({ item: response.item, reason: 'no-difficulty-for-language' });
        continue;
      }
      used.push({ item: response.item, correct: response.correct, difficulty });
    }
    const score = used.reduce((total, response) => total + response.correct, 0);
    const base = { participant: id, language: person.language, answered: used.length, score, excluded };
    if (person.responses.length === 0) {
      results.push({ ...base, theta: null, se: null, extreme: null, reason: 'no-responses' });
    } else if (used.length === 0) {
      results.push({ ...base, theta: null, se: null, extreme: null, reason: 'no-estimable-items' });
    } else if (score === used.length) {
      results.push({ ...base, theta: null, se: null, extreme: 'all-correct' });
    } else if (score === 0) {
      results.push({ ...base, theta: null, se: null, extreme: 'all-wrong' });
    } else {
      let theta = Math.log((score + 0.5) / (used.length - score + 0.5));
      for (let iteration = 0; iteration < 100; iteration += 1) {
        let gradient = 0;
        let information = 0;
        for (const response of used) {
          const probability = Math.min(1 - MIN_PROBABILITY, Math.max(MIN_PROBABILITY,
            logistic(theta - response.difficulty)));
          gradient += response.correct - probability;
          information += probability * (1 - probability);
        }
        const step = Math.max(-STEP_LIMIT, Math.min(STEP_LIMIT, gradient / information));
        theta += step;
        if (Math.abs(step) < 1e-8) break;
      }
      let information = 0;
      for (const response of used) {
        const probability = Math.min(1 - MIN_PROBABILITY, Math.max(MIN_PROBABILITY,
          logistic(theta - response.difficulty)));
        information += probability * (1 - probability);
      }
      results.push({ ...base, theta, se: 1 / Math.sqrt(information), extreme: null });
    }
  }
  return results;
}
