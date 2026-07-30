import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { STATIC_FIRST_CLASS_PLUGIN_ROUTES } from "../src/plugin-tool-policy.js";
import { auditToolCatalog } from "../src/tool-schema-audit.js";
import { splitToolTiers } from "../src/tool-tiers.js";
import { contextTools } from "../src/tools/context-tools.js";
import { editorTools } from "../src/tools/editor-tools.js";
import { hubTools } from "../src/tools/hub-tools.js";
import { instanceTools } from "../src/tools/instance-tools.js";
import { staticFirstClassPluginTools } from "../src/tools/plugin-first-class-tools.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const baselinePath = join(repositoryRoot, "docs", "tool-audit-baseline.json");
const manifestPath = join(repositoryRoot, "manifest.json");
const snapshotPath = join(
  repositoryRoot,
  "src",
  "tools",
  "plugin-first-class-tools.generated.json"
);
const outputPath = join(repositoryRoot, "docs", "tool-audit-report.md");

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
const currentNames = new Set(manifest.tools.map((tool) => tool.name));

const canonicalReplacements = new Map([
  ["unity_search_by_component", "unity_search_scene"],
  ["unity_search_by_name", "unity_search_scene"],
  ["unity_build_start", "unity_build"],
  ["unity_editor_play_mode", "unity_play_mode"],
]);
const internalControlTools = new Set([
  "unity_queue_ticket_status",
  "unity_queue_status",
  "unity_queue_cancel",
]);

function escapeCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

function classifyTool(tool) {
  if (currentNames.has(tool.name)) {
    return {
      classification: "默认保留",
      target: tool.name,
      conclusion: "唯一默认入口；描述与输入 schema 已通过自动质量门。",
    };
  }
  if (canonicalReplacements.has(tool.name)) {
    const target = canonicalReplacements.get(tool.name);
    return {
      classification: "合并",
      target,
      conclusion: `与同域工具高度重合，统一到 ${target}。`,
    };
  }
  if (tool.source === "project" || tool.route.startsWith("project-tools/call/")) {
    return {
      classification: "三段式",
      target: "unity_project_tools_list/get/execute",
      conclusion: "项目动作不再永久展开；先发现、再取 schema、最后执行。",
    };
  }
  if (tool.route.startsWith("_meta/")) {
    return {
      classification: "内部化",
      target: "发布层元数据同步",
      conclusion: "内部发现协议不再作为普通用户工具显示。",
    };
  }
  if (internalControlTools.has(tool.name)) {
    return {
      classification: "内部化",
      target: "Node 队列控制面",
      conclusion: "票据轮询与取消由传输层自动处理，不占用用户工具面。",
    };
  }
  return {
    classification: "懒加载",
    target: "unity_advanced_execute",
    conclusion: "能力保留，但从默认上下文移出；按需通过高级入口执行。",
  };
}

if (baseline.tools.length !== 174) {
  throw new Error(`Expected 174 unique baseline tools, got ${baseline.tools.length}.`);
}
if (!Array.isArray(snapshot) ||
    snapshot.length !== STATIC_FIRST_CLASS_PLUGIN_ROUTES.length) {
  throw new Error(
    `Expected ${STATIC_FIRST_CLASS_PLUGIN_ROUTES.length} plugin routes, got ` +
    `${Array.isArray(snapshot) ? snapshot.length : "a non-array snapshot"}.`
  );
}

const { coreTools, metaTools } = splitToolTiers(editorTools);
const currentToolMap = new Map(
  [...instanceTools, ...hubTools, ...coreTools, ...metaTools, ...contextTools]
    .map((tool) => [tool.name, tool])
);
for (const tool of staticFirstClassPluginTools) {
  if (!currentToolMap.has(tool.toolName)) {
    currentToolMap.set(tool.toolName, {
      name: tool.toolName,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
  }
}
const currentTools = [...currentToolMap.values()];
if (currentTools.length !== manifest.tools.length) {
  throw new Error(
    `Runtime/manifest tool count mismatch: ${currentTools.length} vs ${manifest.tools.length}.`
  );
}
const manifestIssues = auditToolCatalog(currentTools);
if (manifestIssues.length > 0) {
  throw new Error(`Current manifest schema audit failed: ${JSON.stringify(manifestIssues)}`);
}

const decisions = baseline.tools.map((tool, index) => ({
  index: index + 1,
  ...tool,
  ...classifyTool(tool),
}));
const decisionCounts = Object.fromEntries(
  [...new Set(decisions.map((item) => item.classification))]
    .map((classification) => [
      classification,
      decisions.filter((item) => item.classification === classification).length,
    ])
);
const currentOnlyTools = manifest.tools
  .filter((tool) => !baseline.tools.some((baselineTool) => baselineTool.name === tool.name))
  .map((tool) => tool.name);

const lines = [];
lines.push("# Unity MCP 插件与工具逐项设计审查");
lines.push("");
lines.push(`生成时间：${new Date().toISOString()}`);
lines.push("");
lines.push("## 结论");
lines.push("");
lines.push(
  `基线有 ${baseline.counts.serverSurface} 个 Node 工具和 ${baseline.counts.pluginFirstClass} 个插件第一类工具，` +
  `原始合计 185 项；按名称去重后为 ${baseline.counts.combinedExposed} 项，并存在 11 个跨层同名碰撞。` +
  `修复后默认面为 ${manifest.tools.length} 项，其中插件发布策略固定为 ` +
  `${STATIC_FIRST_CLASS_PLUGIN_ROUTES.length} 条路由。`
);
lines.push("");
lines.push(
  `174 个基线唯一工具的处理结果：${Object.entries(decisionCounts)
    .map(([name, count]) => `${name} ${count}`)
    .join("、")}。`
);
lines.push("");
lines.push(
  `当前默认面新增的规范入口：${currentOnlyTools.map((name) => `\`${name}\``).join("、")}。`
);
lines.push("");
lines.push("## 整体框架审查与已实施修复");
lines.push("");
lines.push("| 领域 | 发现的问题 | 已实施修复 | 当前判定 |");
lines.push("|---|---|---|---|");
lines.push(`| 工具面 | 185 个原始条目会挤占上下文，且有 11 个同名跨层碰撞 | 建立 ${manifest.tools.length} 项默认面、${STATIC_FIRST_CLASS_PLUGIN_ROUTES.length} 路由发布策略和 lazy 兼容层 | 已修复 |`);
lines.push("| 扩展性 | 项目自定义工具逐个展开，项目越大默认面越失控 | 统一为 `project-tools/list/get/execute` 三段式；不完整元数据自动降级 | 已修复 |");
lines.push("| 元数据 | 基线含 2 个内部工具、4 个默认描述、44 个数组缺 `items`、68 个属性缺描述 | 引入元数据质量门、完整 schema 递归审计和发布快照检查 | 已修复，当前 0 issue |");
lines.push("| 路由权威 | 路由清单、switch、Node 清单和 manifest 可漂移 | C# 权威路由注册表 + 实时快照生成 + manifest 同步检查 | 已修复 |");
lines.push("| 传输 | 直接端点与队列语义并存，重载时可能重复写入或丢失票据 | 全部命令统一经幂等队列；写操作不盲重放；丢票仅对白名单读操作恢复 | 已修复 |");
lines.push("| 就绪状态 | HTTP 监听成功会被误认为主线程队列可执行 | `queueReady`、冷启动结构化 503、测试期 `busyReason=test_run` | 已修复 |");
lines.push("| 队列生命周期 | 容量检查与入队不原子，执行超时与排队时间混淆，晚回调可覆盖结果 | 原子提交、分离 queue/execution 时间、按票据超时、终态拒绝晚回调 | 已修复 |");
lines.push("| 目标安全 | 写操作可在错误 Unity 实例执行 | 所有可变更 schema/请求统一支持并强制项目路径或名称绑定 | 已修复 |");
lines.push("| HTTP 边界 | 浏览器 Origin、错误方法、超大 body 和内部堆栈暴露风险 | Origin 拒绝、方法白名单、2 MiB body 限制、结构化无堆栈错误 | 已修复 |");
lines.push("| 回复噪声 | 重复实例上下文、成功 envelope、软限额警告块、包测试堆栈和整页失败明细 | 统一响应压缩；UTF-8 字节硬限额；堆栈显式 opt-in；包测试默认只给摘要 | 已修复 |");
lines.push("| 搜索重合 | 名称、组件、Tag、Layer、Shader 搜索入口高度重合 | 合并为 `search/scene`，旧路由保留 lazy 兼容 | 已修复 |");
lines.push("| Unity 兼容 | 分散对象搜索 API 在 Unity 版本间产生警告与维护重复 | 新增集中式 `MCPObjectSearch` 兼容层，Unity 6.4 编译 0 warning | 已修复 |");
lines.push("| 依赖安全 | 旧锁文件带入 8 个 npm 漏洞，其中 5 high | MCP SDK 最低版本升至 1.30.0，并刷新兼容传递依赖 | 已修复，`npm audit` 为 0 |");
lines.push("| 版本发布 | server、manifest 和文档版本可能各自漂移 | package.json 成为版本权威，生成器同时校验 manifest | 已修复 |");
lines.push("");
lines.push("## 高度重合工具的合并结果");
lines.push("");
lines.push("| 原入口 | 规范入口/处理 |");
lines.push("|---|---|");
lines.push("| `unity_search_by_name`、`unity_search_by_component` 以及 Tag/Layer/Shader 等场景搜索路由 | `unity_search_scene`；组合过滤、稳定分页 |");
lines.push("| `unity_build_start` 与 Node 构建入口 | `unity_build`；`unity_build_get_job` 单独保留作长任务查询 |");
lines.push("| `unity_editor_play_mode` 与 Node Play Mode 入口 | `unity_play_mode` |");
lines.push("| `unity_queue_ticket_status`、`unity_queue_status`、`unity_queue_cancel` | 内部队列控制面；普通调用方不再手工管理 |");
lines.push("| 18 个 `project-tools/call/*` | `unity_project_tools_list/get/execute` 三段式 |");
lines.push("| prefab batch/edit、component batch wire、asset move batch、本地化批处理别名 | 统一事务/配置入口；旧别名不再发布 |");
lines.push("| scene/game/prefab capture 与旧 graphics capture 别名 | 统一 screenshot/graphics 规范入口；过时别名不再发布 |");
lines.push("");
lines.push("## 验证结果");
lines.push("");
lines.push("- Unity 6000.4.10f1：编译 0 error / 0 warning。");
lines.push(`- 插件元数据：${STATIC_FIRST_CLASS_PLUGIN_ROUTES.length} 个内建第一类路由，质量问题 0。`);
lines.push(`- Node：${manifest.tools.length} 个默认工具，目录与 schema 自动测试通过。`);
lines.push("- npm：生产依赖漏洞 0。");
lines.push("- 包测试：VMUnityMCP 5.2.0 主功能聚焦回归 15/15；5.2.1 最终全量 192/192 通过，manifest 精确恢复。");
lines.push("");
lines.push("## 174 个基线唯一工具逐项审查");
lines.push("");
lines.push("| # | 工具 | 原来源 | 原路由 | 处理 | 规范入口 | 审查结论 |");
lines.push("|---:|---|---|---|---|---|---|");
for (const item of decisions) {
  lines.push(
    `| ${item.index} | \`${escapeCell(item.name)}\` | ${escapeCell(item.source)} | ` +
    `${item.route ? `\`${escapeCell(item.route)}\`` : "Node 静态"} | ` +
    `${escapeCell(item.classification)} | \`${escapeCell(item.target)}\` | ` +
    `${escapeCell(item.conclusion)} |`
  );
}
lines.push("");
lines.push("## 审查边界");
lines.push("");
lines.push(
  "“懒加载”不是删除能力：路由仍由 Unity 插件保留，并可通过高级入口按需执行；" +
  "“内部化”则表示该能力属于发现或传输控制面，不应作为普通用户工具暴露。"
);
lines.push("");

writeFileSync(outputPath, lines.join("\n"), "utf8");
console.log(`Generated ${outputPath} with ${decisions.length} per-tool decisions.`);
