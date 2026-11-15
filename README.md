# training-scale

answered=false 的 correct 仅为存储占位，不参与答对率；题目版本独立登记。

项目目前提供本地记录校验、输入指纹、按 `item` 的原始核算，以及二元 Rasch 题项分析：联合拟合区分参与者能力与题目难度，通过配置的共同锚题连接两个语言版本，产出语言 DIF 复核清单；新批次答题可用已发布的模型档案做冻结能力评分。分析人员可以保留完整输入并复查每次导出的 JSON；原始数据不被命令改写。业务配置位于 `data/policy.json`，字段约定在 `docs/data.md`，分析口径在 `docs/rasch.md`。

## 运行

使用 Node.js 22 LTS（>=22.22.1 且 <23）和 npm，无第三方运行依赖。
`.nvmrc` 选择 22 主版本，清单与锁文件记录相同的兼容范围；Dockerfile 仍固定基础镜像摘要，容器构建可精确复现。

```sh
npm ci --ignore-scripts --no-audit --no-fund --offline
npm run build
npm test
npm run summary
node src/cli.js inspect --input data/records.json
node src/cli.js summary --input data/records.json --out var/summary.json
node src/cli.js analyze --input data/records.json --policy data/policy.json --out var/model.json
node src/cli.js score --input data/records.json --model var/model.json --out var/scores.json
npm run demo
```

`npm run demo` 在本地打印输入、现有核算、配置、Rasch 分析与冻结评分示例并生成 `var/` 下的输出，不访问网络、不等待真实业务时间，通常几秒内完成。输出目录可删除后重新运行，测试只使用临时目录。

## 命令

- `inspect`：输入行数、字段列表与 SHA-256 指纹。
- `summary`：按 `item` 的原始答对率清点（保留的旧核算，不做统计推断）。
- `analyze`：Rasch 联合拟合 + 连接检查 + 语言 DIF + 锚题净化，产出模型档案与题项复核清单；断开的版本不会声称已经等值。
- `score`：只用档案中已发布的难度估计新批次能力，不重新拟合题目参数；档案不被修改。

分析结果用于题项复核与能力描述，不构成人员淘汰或分班决定。

## 容器

```sh
docker build -t training-scale:local .
docker run --rm --network none training-scale:local
```

Dockerfile 固定 Node.js 基础镜像摘要，构建时执行语法检查和测试。镜像构建完成后演示无需联网；可覆盖命令运行 `npm test`。构建不需要真实账号、邮件服务、数据库或线上数据。

## 目录

- `src/dataset.js`：记录校验、规范序列化和数据指纹。
- `src/domain.js`：当前业务分组核算。
- `src/rasch.js`：Rasch 联合拟合（CML 难度 + ML 能力）、连接检查、DIF 检验、锚题净化与冻结评分的纯函数。
- `src/analyze.js`：分析流程装配、模型档案与评分文档。
- `src/policy.js`：分析配置校验。
- `src/cli.js`：本地读取、检查和导出入口。
- `src/output.js`：以临时文件写入后替换完整 JSON。
- `test/`：输入约束、领域核对、命令与输出回归、Rasch 合成数据与评分行为。
- `data/`：合成记录、独立核对值及本地业务配置。
- `docs/`：数据字段约定与 Rasch 分析口径。
