import { readFile } from 'node:fs/promises';

// 分析配置校验：锚题、参考语言、净化轮次上限、显著性水平与冻结题目版本。
// 未知字段留给前向兼容，已知字段类型不符直接拒绝。
export function validatePolicy(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('分析配置应为对象');
  }
  const { anchors, referenceLanguage, maxPurification, alpha, frozenVersion } = policy;
  if (!Array.isArray(anchors) || anchors.length === 0
    || anchors.some(anchor => typeof anchor !== 'string' || anchor.length === 0)) {
    throw new Error('配置 anchors 应为非空字符串数组');
  }
  if (new Set(anchors).size !== anchors.length) throw new Error('配置 anchors 不可重复');
  if (typeof referenceLanguage !== 'string' || referenceLanguage.length === 0) {
    throw new Error('配置 referenceLanguage 应为非空字符串');
  }
  if (!Number.isSafeInteger(maxPurification) || maxPurification < 0 || maxPurification > 20) {
    throw new Error('配置 maxPurification 应为 0 到 20 的整数');
  }
  if (typeof alpha !== 'number' || !(alpha > 0 && alpha < 1)) {
    throw new Error('配置 alpha 应在 (0, 1) 区间内');
  }
  if (typeof frozenVersion !== 'string' || frozenVersion.length === 0) {
    throw new Error('配置 frozenVersion 应为非空字符串');
  }
  return { anchors: [...anchors], referenceLanguage, maxPurification, alpha, frozenVersion };
}

export async function loadPolicy(path) {
  return validatePolicy(JSON.parse(await readFile(path, 'utf8')));
}
