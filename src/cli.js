import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadDataset } from './dataset.js';
import { summarize } from './domain.js';
import { writeResult } from './output.js';
import { loadPolicy } from './policy.js';
import { runAnalysis, runScoring, loadModel } from './analyze.js';

const COMMANDS = ['summary', 'inspect', 'analyze', 'score'];
const OPTIONS = ['--input', '--out', '--policy', '--model'];

export function parseArguments(args) {
  const [command = 'summary', ...options] = args;
  if (!COMMANDS.includes(command)) throw new Error(`命令应为 ${COMMANDS.join(' 或 ')}`);
  const result = { command, input: 'data/records.json' };
  if (command === 'analyze') result.policy = 'data/policy.json';
  const seen = new Set();
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index];
    const value = options[index + 1];
    if (!OPTIONS.includes(name) || !value || value.startsWith('--')) {
      throw new Error(`参数应为 ${OPTIONS.join('、')} 后接路径`);
    }
    if (seen.has(name)) throw new Error('参数不可重复');
    seen.add(name);
    result[name.slice(2)] = value;
  }
  if (command === 'score' && !result.model) {
    throw new Error('参数缺少 --model（评分所需的模型档案路径）');
  }
  return result;
}

export async function main(args) {
  const options = parseArguments(args);
  const dataset = await loadDataset(options.input);
  let document;
  if (options.command === 'summary') {
    document = { ...summarize(dataset.records), inputFingerprint: dataset.fingerprint };
  } else if (options.command === 'inspect') {
    document = {
      records: dataset.records.length,
      fingerprint: dataset.fingerprint,
      fields: dataset.records.length ? Object.keys(dataset.records[0]).sort() : [],
      inputFingerprint: dataset.fingerprint,
    };
  } else if (options.command === 'analyze') {
    const policy = await loadPolicy(options.policy);
    document = runAnalysis(dataset.records, policy, dataset.fingerprint);
  } else {
    const model = await loadModel(options.model);
    document = runScoring(dataset.records, model, dataset.fingerprint);
  }
  if (options.out) await writeResult(options.out, document);
  return document;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch(error => {
    process.stderr.write(`处理失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
