import { readFile } from 'node:fs/promises';
import { fingerprint } from './dataset.js';
import {
  buildDesign,
  checkLinkage,
  selectEstimable,
  fitRasch,
  difTests,
  purifyAnchors,
  scorePersons,
} from './rasch.js';

export const MODEL_KIND = 'training-scale/rasch-model';
export const SCORES_KIND = 'training-scale/rasch-scores';

// 结果用于题项复核与能力描述；本工具不做、也不应被用来自动淘汰或分班决定。
const USAGE = '本结果用于题项复核与能力描述，不构成人员淘汰或分班决定；请勿据此自动淘汰人员';

const byKey = (left, right) => left.localeCompare(right, 'en');

function inputFingerprintOf(records, provided) {
  if (provided) return provided;
  return fingerprint([...records].sort((left, right) => byKey(left.id, right.id)));
}

function baseDocument(records, policy, inputFingerprint) {
  return {
    kind: MODEL_KIND,
    modelVersion: 1,
    inputFingerprint,
    policy: {
      anchors: policy.anchors,
      referenceLanguage: policy.referenceLanguage,
      alpha: policy.alpha,
      maxPurification: policy.maxPurification,
      frozenVersion: policy.frozenVersion,
    },
    policyFingerprint: fingerprint(policy),
    usage: USAGE,
  };
}

// 联合拟合 + 等值检查 + DIF + 锚题净化，产出模型档案（含复核清单）。
// 断开的版本不出具参数，equating.status 明确标注，不声称已经等值。
export function runAnalysis(records, policy, providedFingerprint) {
  const design = buildDesign(records, { frozenVersion: policy.frozenVersion });
  const linkage = checkLinkage(design, policy.anchors);
  const notes = [];
  const document = {
    ...baseDocument(records, policy, inputFingerprintOf(records, providedFingerprint)),
    languages: design.languages,
    items: Object.fromEntries([...design.items.entries()].sort(([a], [b]) => byKey(a, b))
      .map(([item, entry]) => [item, { version: [...entry.versions][0] }])),
    equating: null,
    anchors: null,
    parameters: null,
    diagnostics: null,
    purification: null,
    dif: null,
    reviewList: [],
    inference: 'none',
    notes,
  };
  if (!design.languages.includes(policy.referenceLanguage)) {
    throw new Error(`参考语言 ${policy.referenceLanguage} 在数据中没有任何记录`);
  }
  const anyResponses = [...design.persons.values()].some(person => person.responses.length > 0);
  if (!anyResponses) {
    document.equating = { status: 'no-responses', proceed: false, reasons: ['没有任何已答记录'] };
    notes.push('所有记录均为缺答，无法拟合');
    return document;
  }
  if (!linkage.connected) {
    document.equating = {
      status: 'disconnected',
      proceed: false,
      stage: 'design',
      components: linkage.components,
      anchorCoverage: linkage.anchorCoverage,
      personsWithoutResponses: linkage.personsWithoutResponses,
      reasons: linkage.reasons,
    };
    notes.push('参与者—题项图不连通，两个语言版本不能声称已经等值；未出具参数');
    return document;
  }
  if (design.languages.length >= 2 && !linkage.linked) {
    document.equating = {
      status: 'anchors-not-covering',
      proceed: false,
      stage: 'design',
      components: linkage.components,
      anchorCoverage: linkage.anchorCoverage,
      reasons: linkage.reasons,
    };
    notes.push('锚题未在两种及以上语言中形成覆盖，无法连接版本；未出具参数');
    return document;
  }

  const estimable = selectEstimable(design);
  const activeItems = new Set([...estimable.activeCells].map(key => key.split('')[0]));
  const droppedAnchors = policy.anchors
    .filter(anchor => !activeItems.has(anchor))
    .map(anchor => ({
      anchor,
      reason: design.items.has(anchor) ? 'cell-extreme-or-empty' : 'not-in-data',
    }));
  if (droppedAnchors.length) {
    notes.push(`配置的锚题中 ${droppedAnchors.length} 个无可估计单元格，未进入锚集：${droppedAnchors.map(entry => entry.anchor).join('、')}`);
  }
  const usableAnchors = policy.anchors.filter(anchor => activeItems.has(anchor));
  const equatingBase = {
    components: linkage.components,
    anchorCoverage: linkage.anchorCoverage,
    personsWithoutResponses: linkage.personsWithoutResponses,
  };
  if (estimable.activePersons.size === 0 || estimable.activeCells.size === 0) {
    document.equating = { status: 'not-estimable', proceed: false, ...equatingBase };
    document.diagnostics = {
      excludedPersons: estimable.excludedPersons,
      excludedCells: estimable.excludedCells,
    };
    notes.push('剔除极端分后没有可估计的参与者或单元格');
    return document;
  }
  if (usableAnchors.length === 0) {
    document.equating = { status: 'anchors-unusable', proceed: false, ...equatingBase };
    document.anchors = { configured: policy.anchors, dropped: droppedAnchors, final: [], removed: [] };
    document.diagnostics = {
      excludedPersons: estimable.excludedPersons,
      excludedCells: estimable.excludedCells,
    };
    notes.push('没有可用锚题，尺度无法定位；未出具参数');
    return document;
  }

  // 剔除极端分后的可估计设计必须重新检查：原始设计连通不代表剔除后仍连通
  const estimableLinkage = checkLinkage(design, usableAnchors, estimable);
  if (!estimableLinkage.connected || (design.languages.length >= 2 && !estimableLinkage.linked)) {
    document.equating = {
      status: !estimableLinkage.connected ? 'disconnected' : 'anchors-not-covering',
      proceed: false,
      stage: 'estimable',
      components: estimableLinkage.components,
      anchorCoverage: estimableLinkage.anchorCoverage,
      reasons: estimableLinkage.reasons,
    };
    document.anchors = { configured: policy.anchors, dropped: droppedAnchors, final: [], removed: [] };
    document.diagnostics = {
      excludedPersons: estimable.excludedPersons,
      excludedCells: estimable.excludedCells,
    };
    document.reviewList = estimable.excludedCells.map(cell => ({
      item: cell.item, language: cell.language, reason: 'cell-extreme', detail: cell.reason,
    }));
    notes.push('剔除全对/全错的极端单元格后，可估计设计不再连通或锚题失去跨语种覆盖；'
      + '两个语言版本不能声称已经等值，未出具参数');
    return document;
  }

  const purification = purifyAnchors(design, estimable, usableAnchors, policy);
  document.purification = purification;
  document.anchors = {
    configured: policy.anchors,
    dropped: droppedAnchors,
    final: purification.finalAnchors,
    removed: purification.removed,
  };
  if (purification.finalAnchors.length === 0) {
    document.equating = { status: 'anchors-exhausted', proceed: false, ...equatingBase };
    document.diagnostics = {
      excludedPersons: estimable.excludedPersons,
      excludedCells: estimable.excludedCells,
    };
    document.inference = 'exploratory';
    document.reviewList = purification.removed.map(entry => ({
      item: entry.anchor,
      reason: 'anchor-removed',
      round: entry.round,
      detail: entry.detail,
    }));
    notes.push('全部锚题在预设净化规则下失效，两个语言版本不能声称已经等值；未出具参数');
    notes.push('锚集经过数据驱动的净化，过程记录属探索性，不能当作确认性结论');
    return document;
  }

  const fit = fitRasch(design, estimable, purification.finalAnchors);
  const dif = design.languages.length >= 2
    ? difTests(fit, design, policy.referenceLanguage, policy.alpha)
    : { status: 'single-language', tests: [], untestable: [] };
  const inference = purification.removed.length > 0 ? 'exploratory' : 'confirmatory';

  document.equating = {
    status: design.languages.length >= 2 ? 'linked' : 'not-applicable',
    proceed: true,
    ...equatingBase,
  };
  document.parameters = { constraint: 'anchor-mean-zero', difficulties: fit.difficulties };
  document.diagnostics = {
    ...fit.diagnostics,
    excludedPersons: estimable.excludedPersons,
    excludedCells: estimable.excludedCells,
  };
  document.dif = dif;
  document.inference = inference;
  document.reviewList = buildReviewList(dif, purification, estimable, droppedAnchors);
  if (inference === 'exploratory') {
    notes.push('锚集经过数据驱动的净化，结果属探索性，不能当作确认性结论；如需确认请用独立数据复核');
  }
  if (purification.status === 'round-limit-reached') {
    notes.push('锚题净化达到预设轮次上限仍未稳定，剩余锚题按存疑处理');
  }
  if (purification.status === 'too-few-to-test') {
    notes.push('净化后剩余锚题不足两个，无法再用预设规则检验；剩余锚题未经再验证');
  }
  if (!fit.diagnostics.converged) {
    notes.push('联合拟合在迭代上限内未收敛，参数仅供参考');
  }
  return document;
}

function buildReviewList(dif, purification, estimable, droppedAnchors) {
  const list = [];
  for (const test of dif.tests ?? []) {
    if (test.flagged) {
      list.push({
        item: test.item,
        language: test.language,
        reason: 'dif-significant',
        delta: test.delta,
        se: test.se,
        ci95: test.ci95,
        p: test.p,
        q: test.q,
        etsClass: test.etsClass,
        support: test.support,
      });
    }
  }
  for (const entry of dif.untestable ?? []) {
    list.push({ item: entry.item, language: entry.language, reason: 'dif-untestable', detail: entry.reason });
  }
  for (const removal of purification.removed) {
    list.push({ item: removal.anchor, reason: 'anchor-removed', round: removal.round, detail: removal.detail });
  }
  for (const dropped of droppedAnchors) {
    list.push({ item: dropped.anchor, reason: 'anchor-unusable', detail: dropped.reason });
  }
  for (const cell of estimable.excludedCells) {
    list.push({ item: cell.item, language: cell.language, reason: 'cell-extreme', detail: cell.reason });
  }
  return list.sort((left, right) => byKey(left.item, right.item)
    || byKey(left.language ?? '', right.language ?? '')
    || byKey(left.reason, right.reason));
}

// 冻结评分：只读模型档案，用已发布难度估计新批次能力，不重新拟合题目参数。
export function runScoring(records, model, providedFingerprint) {
  const validated = validateModel(model);
  const design = buildDesign(records);
  const persons = scorePersons(design, validated);
  const excludedSummary = {};
  for (const person of persons) {
    for (const entry of person.excluded) {
      const key = `${entry.item} (${entry.reason})`;
      excludedSummary[key] = (excludedSummary[key] ?? 0) + 1;
    }
  }
  return {
    kind: SCORES_KIND,
    scoresVersion: 1,
    inputFingerprint: inputFingerprintOf(records, providedFingerprint),
    modelFingerprint: fingerprint(validated),
    difficultiesFrozen: true,
    persons,
    excludedSummary,
    notes: [
      '能力评分使用模型档案中已发布的题目难度，未重新拟合；档案不被本命令修改',
      '缺答记录不参与评分；全对或全错的参与者能力无界，theta 记为 null 并标注',
    ],
    usage: USAGE,
  };
}

export function validateModel(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('模型档案应为对象');
  }
  if (document.kind !== MODEL_KIND) throw new Error(`模型档案 kind 应为 ${MODEL_KIND}`);
  if (document.modelVersion !== 1) throw new Error('不支持的模型档案版本');
  if (!document.parameters || typeof document.parameters !== 'object'
    || !document.parameters.difficulties || typeof document.parameters.difficulties !== 'object') {
    throw new Error('模型档案不含已发布参数（拟合未成功或锚题失效），不能用于评分');
  }
  if (!document.items || typeof document.items !== 'object' || Array.isArray(document.items)) {
    throw new Error('模型档案缺少题目版本登记');
  }
  return document;
}

export async function loadModel(path) {
  return validateModel(JSON.parse(await readFile(path, 'utf8')));
}
