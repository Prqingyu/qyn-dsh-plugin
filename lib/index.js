/**
 * qyn-time — DSH 插件：把时间管理内核封装成工具
 *
 * ## 设计定位：**薄适配层**
 *
 * 这个插件只做三件事：
 *   1. 注册工具（名字 + 参数 schema），让模型知道"能做什么"
 *   2. 调 Python 内核（`AGENT/qyn.py <cmd> ...`），把它当唯一的写入口
 *   3. 把内核返回的 JSON 原样交回模型
 *
 * **插件里没有任何业务逻辑** —— 不解析日期、不判断状态、不裁剪数据。
 * 因为内核已经被 24 项测试钉住了（ISO 周跨年、schema 校验、保守匹配……），
 * 把这些逻辑重写进 TypeScript 等于把踩过的坑再踩一遍。
 *
 * 分工因此是：
 *   模型 = 理解自然语言；内核 = 保证结构合法；插件 = 把两者接起来。
 *
 * ## 零 npm 依赖
 * 只用 node 内置模块。原因：插件要装到**没有外网**的中控机上，
 * 依赖越少越可靠。@deepseek-ai/* 一律动态 import + 缺失降级。
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export const name = 'qyn-time';

// 静态 inject：不用 ctx.inject(cb) 的运行时回调 —— 经调研，那套回调在
// 某些宿主（web-app）里会**静默不触发**，排查成本极高。显式声明依赖最可靠。
export const inject = ['tools'];

/** 配置 schema（schemastery）。缺失时降级为只用环境变量/默认值。 */
let Config;
try {
  const { default: z } = await import('@deepseek-ai/schemastery');
  // ★ 这里**故意不给 default**：给了 default，`config.repoRoot` 就恒有值，
  //   下面那句 `|| process.env.QYN_REPO_ROOT` 会变成死分支 —— 而 profile 里刻意不配
  //   repoRoot（开发机与中控机路径不同），全靠环境变量。实测踩过：服务的工作目录
  //   从 release 改成稳定父目录后，cwd 不再是仓库根 ⇒ 按 cwd 找内核必然找不到，
  //   于是**所有轮次的 qyn 工具都没注册**，Agent 只能靠提示词回答。
  Config = z.object({
    repoRoot: z.string()
      .description('仓库根目录（AGENT/qyn.py 所在处）；不配则用 $QYN_REPO_ROOT，再退回 cwd'),
    python: z.string()
      .description('Python 解释器；不配则用 $QYN_PYTHON，再退回平台默认'),
    timeoutMs: z.number().default(60000)
      .description('单次内核调用的超时（毫秒）'),
  });
} catch {
  // 拿不到 schemastery 不是致命错误：apply 会用同样的默认值
  Config = undefined;
}
export { Config };

function defaultPython() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

function log(ctx, level, message) {
  // **两路都写**：ctx.logger 走宿主日志管线，stderr 保证在 CLI/headless 下一定看得见。
  // 为什么在意这个：插件最坏的失败形态是"加载了但没生效"或"根本没加载"，
  // 而两者都表现为**一片安静**。宁可启动时多一行日志。
  const logger = ctx?.logger;
  if (logger && typeof logger[level] === 'function') logger[level](message);
  console.error(`[qyn-time] ${message}`);
}

/* ────────────────────────── 内核调用 ────────────────────────── */

/**
 * 跑一次内核命令并把输出解析成 JSON。
 *
 * 内核的约定（见 AGENT/qyn.py）：
 *   · 成功 → stdout 是 JSON，退出码 0
 *   · 失败 → stderr 是 JSON（含 ok:false 与 hint），退出码非 0
 * 两种都解析成对象返回 —— 让模型看到结构化的失败原因，而不是一句 "command failed"。
 */
function runKernel({ kernel, python, repoRoot, timeoutMs }, cmdArgs) {
  return new Promise((resolve) => {
    execFile(python, [kernel, ...cmdArgs],
      { cwd: repoRoot, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const raw = (stdout && stdout.trim()) || (stderr && stderr.trim()) || '';
        if (!raw) {
          resolve({ ok: false, error: err ? String(err.message) : '内核没有任何输出' });
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({
            ok: false,
            error: '内核输出不是 JSON（可能语法错误或解释器不对）',
            exitCode: typeof err?.code === 'number' ? err.code : 0,
            output: raw.slice(0, 500),
          });
        }
      });
  });
}

function textOutput() {
  return {
    schema: { type: 'object' },
    render: (_args, value) => [
      { type: 'text', text: JSON.stringify(value, null, 2) },
    ],
  };
}

/**
 * 组一个**标准 JSON Schema** 的对象根参数。
 *
 * ⚠️ 这里踩过一个真实的坑，记下来免得重犯：
 *   DSH 官方的 `defineTool()` 会把自研 DSL（`{ 属性: {...} }` + 逐属性 `required: true`）
 *   **转换**成 JSON Schema；但插件直接 `ctx.tools.register(裸对象)` 时，
 *   `parameters` 会被**原样透传**给上游 provider。于是：
 *     · `parameters: {}` 恰好是合法 JSON Schema（空 schema）→ 侥幸通过
 *     · `parameters: { horizon: {...} }` 缺 `type` → 上游 400：
 *         Invalid schema for function 'qyn_anomalies':
 *         schema must be a JSON Schema of 'type: "object"', got 'type: null'
 *   结论：**不用 defineTool 就必须自己写标准 JSON Schema**。顺带少一个对
 *   `@deepseek-ai/dsh-tools` 能否解析的依赖（中控机没外网，依赖越少越好）。
 */
function obj(properties, required) {
  const schema = { type: 'object', properties, additionalProperties: false };
  if (Array.isArray(required) && required.length > 0) schema.required = required;
  return schema;
}

/* ────────────────────────── 工具定义 ────────────────────────── */

function buildTools(kernelCtx) {
  const run = (args) => runKernel(kernelCtx, args);

  return [
    {
      name: 'qyn_state',
      description:
        '读取信息中心的完整现状：规划规则、课次概览、周期任务、待办清单，' +
        '**以及上次的规划 `last_plan`**（含 `stale`：数据在它之后又变过就该重排）。' +
        '任何操作前先调用它，不要凭记忆。' +
        '★★ **上次的规划是派生物**：排期时**从头重算**（注册表 + 规则 + 课表）—— ' +
        '**不要拿旧计划的时段接着用**；旧快照只用来对账（上次答应过用户什么）。' +
        '★ 返回带 **`now`**（当前时刻/周几/时段）—— 规划的时间参照，别自己估；' +
        '`why` 里的剩余时间就是相对它算的，所以**早上问和深夜问结果不同**。' +
        '★ `active` 是**已按紧迫度排好序**的注册清单，每条带 `urgency`(urgent/soon/normal/later)' +
        ' 与 `why`（凭什么这么排）—— **直接用这个顺序**，不要自己再排一遍；' +
        '它**不含** `status`（清单上必然未完成）也不含 `priority`（轻重由 urgency 表达）。' +
        '★ 日期一律是具体日期，系统不做「第N周」推算。',
      parameters: obj({}),
      output: textOutput(),
      async execute() {
        return run(['context']);
      },
    },
    {
      name: 'qyn_sessions',
      description:
        '接下来 N 天的**课次与待办**（按实际日期/时刻，与周次无关）。排期时用它，不要只看「本周」。' +
        '★ 返回里带 `now`（当前时刻）；`sessions` 只给**还没下课**的课次（今天早上那节到晚上就不列了），' +
        '每节带 `starts_in`；`due` 是**非课次**待办，已按紧迫度排序。' +
        '同一个问题早上问和深夜问，**返回不同** —— 以 `now` 与 `why` 为准，不要自己估时间。' +
        '★ **单次最多 60 节**：`more` 不为 0 就是还有没给的，`capped_at` 是最后一节的日期 —— ' +
        '缩小 days 从那里往后看，或提高 limit。',
      parameters: obj({
        days: { type: 'integer', description: '往后看几天，默认 14' },
        limit: { type: 'integer',
                 description: '单次最多返回几节（默认 60）。课表可以给一学期，但视图有限' },
      }),
      output: textOutput(),
      async execute(args) {
        const a = ['sessions'];
        if (args?.days != null) a.push('--days', String(args.days));
        if (args?.limit != null) a.push('--limit', String(args.limit));
        return run(a);
      },
    },
    {
      name: 'qyn_week',
      description:
        '**某一周课表的完整回读**（只读）—— 录完课表**必须**用它逐条念给用户核对。' +
        '返回 7 天、每天每节的「节次 · 课名 · 教室」；停课/调课还带 `kind` 和依据 `note`。' +
        '\n★ 教室和「校外场地」**每周都可能变**：念的必须是**当周图**上的值，' +
        '不许说「和上周一样」、也不许沿用上一周的教室（硬约束）。' +
        '\n★ 与 `qyn_sessions` 的分工：那个只给未来、且**过滤掉停课**（用来排期）；' +
        '这个是整周全景、含停课与依据（用来**对图**）。' +
        '\n★ 用户发来一张新周课表并让你录入后，回话里就该是这里念出来的那份，' +
        '再加一句「本周哪几格和上周不同（教室/节次/停课调课）」。',
      parameters: obj({
        date: { type: 'string',
                description: '这一周里的任意一天 YYYY-MM-DD（默认今天）' },
      }),
      output: textOutput(),
      async execute(args) {
        const a = ['week'];
        if (args?.date) a.push('--date', String(args.date));
        return run(a);
      },
    },
    {
      name: 'qyn_show',
      description:
        '取回注册表里某条的**完整结构体**（含 detail）。' +
        '用户问「这次作业做哪几题」「有什么额外要求」「在哪交」时用它 —— ' +
        '`qyn_state` 只给**列表视图**（不含 detail，只给 has_detail 标记），详情必须来这里取。' +
        '★ 名称需完全一致；不一致时内核会拒绝并返回已知列表，交给用户确认。' +
        '★ 条目若**已归档**（日期已过、已滚出活跃集），默认只回列表视图字段、' +
        '**不回 detail**；只有用户明确追问这一条的细节时才带 `cold: true` 再取一次。',
      parameters: obj({
        task: { type: 'string', description: '任务名（需完全一致）' },
        cold: { type: 'boolean', description: '已归档条目是否返回完整 detail（默认 false）' },
      }, ['task']),
      output: textOutput(),
      async execute(args) {
        const a = ['show', '--task', String(args.task)];
        if (args?.cold) a.push('--cold');
        return run(a);
      },
    },
    {
      name: 'qyn_anomalies',
      description:
        '读取**确定性**异常清单：周期任务锚不到日期、课表为空、规划规则 scope 失效、' +
        '数据久未维护。已由代码算好，直接用，别再自己判断一遍。' +
        '★ **不含"即将到期"** —— 那看 `qyn_state` 的 `active`（带 urgency / why）。' +
        '★ 这里只有**机制性**事实；"算不算重复""规则该不该清"是你的判断。',
      parameters: obj({}),
      output: textOutput(),
      async execute() {
        return run(['anomalies']);
      },
    },
    {
      name: 'qyn_sync',
      description:
        '**物化**：把「课表里带日期的每一节课」和「周期任务」登记进待办清单（幂等）。' +
        '★ 全程不做周推算：上课条目直接用课表里的日期；作业锚到它那门课**当周实际那节课**的日期。' +
        '录入新课表之后、以及每日检查开头，都该跑它。改条目用 `qyn_apply`，改状态用 `qyn_mark`。' +
        '★★ 返回值里的 **`already_present` 是给你判断的，不是给你忽略的**：它的意思是' +
        '"这一天已经有同名条目了，内核**没有**再物化一条，也**没有**替你认领"。' +
        '「循环任务该怎么写」是你的事 —— 判断那条已有条目**是不是**这个周期任务的这一次：' +
        '是 → 用 `qyn_apply` 给它补 `occurrence_of` + `anchored_to`（**认领**，之后不再报）；' +
        '不是 → 改名或另立周期任务。内核只兜底"同一次发生不会被物化两条"。',
      parameters: obj({}),
      output: textOutput(),
      async execute() {
        return run(['sync']);
      },
    },
    {
      name: 'qyn_history',
      description:
        '**已滚出的注册**（日期已过）—— 它们在 `qyn_state` / `qyn_anomalies` 里**看不到**，' +
        '因为注册系统按日期滚转向前：日期一过就滚出活跃集、对模型等效隐藏。' +
        '但隐藏 ≠ 丢失。用户问「上周那件到底交没交」「它怎么不见了」时用这个回溯，' +
        '返回里 `unfinished` 是滚出时仍未处理的名字。' +
        '★ **单次最多 50 条**（`more` 是还有多少条没给）：历史是无限的、模型视图不该无限 —— ' +
        '要更早的就把 `days` 放宽，或把 `limit` 调大（写个数就覆盖默认值），不要指望一次拉完。',
      parameters: obj({
        days: { type: 'integer', description: '往前查几天，默认 30' },
        limit: { type: 'integer', description: '单次最多几条，默认 50' },
      }),
      output: textOutput(),
      async execute(args) {
        const a = ['history'];
        if (args?.days != null) a.push('--days', String(args.days));
        if (args?.limit != null) a.push('--limit', String(args.limit));
        return run(a);
      },
    },
    {
      name: 'qyn_apply',
      description:
        '★ **唯一的写入口**：把「要改什么」写成一份改写意图送进来 —— 课表改 `schedule`、' +
        '规则改 `rules`、作业/提醒/单次任务登记进 `list`（注册表）。**改哪个文件由内容决定。**' +
        '先全量校验再落盘：任一处不合规，一个字节都不写。\n' +
        '【两种写法】数组 = 整段替换；`{upsert, remove}` = 按身份增量（只改一两处时用它，' +
        '别为改一节把整份课表搬回来）。写错键名会明确报错，照着改即可。\n' +
        '【返回值】`report` 必须看，尤其 `check_this`。`report` 按文件分（`list` / `schedule` / ' +
        '`rules`），各给 `added` / `updated` / `removed` / `missing` / `replaced`；' +
        '**只改注册表就只看 `report.list`**（别的键是空的 ≠ 没写成）。' +
        '`missing` = 要删的没匹配上、`replaced` = 同身份被覆盖且名字变了 —— 都不是错误，' +
        '但几乎总是说明你写错了什么，当场纠正并告诉用户。\n' +
        '★ 图/话里读到的信息**全部**放进 `detail`（任意嵌套 JSON），不要压成一句话。\n' +
        '★ `priority` 别默认填；需要提前准备的给 `lead_days:N`（你判断语义、内核做算术）。\n' +
        '★ 这两个是**规划信号**：内核拿它们打分排序，但**不会写进 DDL 的标签** ——\n' +
        '大屏那一行只显示时间（「还剩 6 天」）。要不要提前、提前多久，你在**计划**里说。\n' +
        '\n★ **改过课表**（`schedule.dated_sessions` / `sessions`）时，返回里会多一个 ' +
        '`schedule_diff`：这次**新增/删除/改了哪几格**（含「户外 → 教室」这种教室变化）。' +
        '它必须念给用户 —— 教室和户外每周都变，不念就等于没核对（硬约束）。' +
        '\n★ **各种写法的例子见技能 `qyn-time` 的「apply 怎么写」**（不要凭记忆猜形状）。',
      parameters: obj({
        schedule: {
          type: 'object',
          additionalProperties: true,
          description: '改课表。可含 semester / periods / dated_sessions / sessions / ' +
        '★★ 导入**新一周**课表用 `sessions.upsert`（只加不删）；`dated_sessions` 是' +
        '**整段替换**，会删掉本周课次 —— 内核会拦住这种替换（要真替换就写 ' +
        '`"replace_future": true`）。' +
        '**courses**（课程级属性：水课标这里，标一次该课所有课次都算） / ' +
                       'periodic_tasks。sessions 与 periodic_tasks 支持数组（整段替换）' +
                       '或 {upsert, remove}（增量）。',
        },
        rules: {
          type: 'object',
          additionalProperties: true,
          description: '改规则：{planning_rules: 数组 或 {upsert, remove}（按 id）}。' +
                       '规则两条机械校验的窗口：`no_slots:["HH:MM-HH:MM"]`（固定时段，' +
                       '结束时刻允许 `24:00`）；`before_first_class:{}` 或 ' +
                       '`{max_start:"12:00"}` —— 窗口 = 00:00 到**当天第一节课开始**，' +
                       '仅当那节课 ≤ max_start（默认 12:00，即"上午有课"）时当天才生效；' +
                       '没课 / 只有停课 / 算不出时刻 ⇒ 不生效也不报错。' +
                       '两条窗口都按 `kind` 分级：`preference` ⇒ 警告（可用快照 `allow` 豁免）、' +
                       '`constraint` ⇒ 阻塞。',
        },
        list: {
          type: 'object',
          additionalProperties: false,
          properties: {
            upsert: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description: '条目结构体。**必须有 task**；其余自由 —— `date` 只在**有硬截止**时给，' +
                           '没有就别写这个字段（写了就等于给自己造了个假 DDL）。' +
                           '图上读到的复杂信息都放进 detail（任意嵌套）。按 task 新增或整条替换。' +
                           '★ **同名多条时（周期任务的不同次发生）必须给消歧字段**' +
                           '（`date` / `anchored_to` / `occurrence_of` / `session_key`）指认是哪一条，' +
                           '否则**被拒绝**并返回 `candidates`（不再静默只改第一条）。' +
                           '表里没有这个名字 ⇒ 就是新增（带的 date 等是内容，不是消歧）。',
            },
            remove: {
              type: 'array',
              items: { type: ['string', 'object'] },
              description: '要删除的任务：给名字（字符串），或给对象带消歧字段' +
                           '（`{task, date}` / `{task, anchored_to}` …）。' +
                           '★ **同名多条时必须给消歧字段**，否则被拒绝并返回 `candidates`' +
                           '（以前是按名字**全删**，那是数据事故的源头）。',
            },
          },
        },
        sync: { type: 'boolean', description: '落盘后立即物化进注册表（默认否）' },
      }, []),
      output: textOutput(),
      async execute(args) {
        const patch = {};
        for (const k of ['schedule', 'rules', 'list']) {
          if (args?.[k]) patch[k] = args[k];
        }
        if (Object.keys(patch).length === 0) {
          return { ok: false, error: 'apply 至少要给 schedule / rules / list 之一',
                   hint: '课表给 schedule；作业/单次任务给 list.upsert；规则给 rules' };
        }
        const tmp = path.join(os.tmpdir(), `qyn-apply-${process.pid}-${Date.now()}.json`);
        try {
          fs.writeFileSync(tmp, JSON.stringify(patch, null, 2), 'utf8');
          const a = ['apply', '--file', tmp];
          if (args?.sync) a.push('--sync');
          return await run(a);
        } finally {
          try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响结果 */ }
        }
      },
    },
    {
      name: 'qyn_mark',
      description:
        '把任务标记为某个状态。**只接受名称完全一致的任务**；不一致时内核会拒绝并返回 known_tasks，' +
        '这时应该拿它去问用户，而不是猜。',
      parameters: obj({
        task: { type: 'string', description: '任务名（需完全一致）' },
        status: {
          type: 'string',
          enum: ['done', 'pending', 'cancelled', 'expired'],
          description: 'done=已完成/已提交；cancelled=取消；expired=过期；pending=改回未完成',
        },
        date: {
          type: 'string',
          description: '★ **同名多条时用它指认是哪一次发生**（YYYY-MM-DD）。' +
                       '只有一条同名可以省；多条又不给 ⇒ 被拒绝并返回 candidates。',
        },
      }, ['task', 'status']),
      output: textOutput(),
      async execute(args) {
        const a = ['mark', '--task', String(args.task), '--status', String(args.status)];
        if (args?.date) a.push('--date', String(args.date));
        return run(a);
      },
    },
    {
      name: 'qyn_brief',
      description:
        '★★ **要展示规划/日程/待办时用它 —— 别自己拼排版**：它直接给出发给用户的**正文**（纯文本）。\n' +
        '★ **默认给 `plan`（规划）**；`todo` / `schedule` **只在用户点名时给**' +
        '（「待办/手头有什么」⇒ `todo`；「日程/课表/这周怎么安排」⇒ `schedule`）。\n' +
        '`plan` 规划（带时间、**不含课**）/ `schedule` 日程（课程 + 规划、按时序混排）/ ' +
        '`todo` 待办（两张表：按截止日期 / 按紧迫度）。\n' +
        '拿到 `text` 后**原样发出**，只在「现在做什么」块里补一行 `- 建议：…`（你自己的下一步主张）。' +
        '**不要改动其余行、不要重排、不要往规划里加课**（要含课就用 schedule）。\n' +
        '★ `warnings` 里出现 `loop`：最近 30 分钟已存 ≥3 份快照（你在反复重排）。' +
        '**这次照发**（正文是好的），但别再重排了。\n' +
        '★★ 若 `ok=false` 且 `kind=loop`：反复重排**而且**这份还有阻塞 —— **停下**，' +
        '把 `problems` 里卡住的地方告诉用户（别只说「排不下」）。\n' +
        '★★ **若返回 `ok=false`**：快照过期或有**禁止**类违反（`problems` 逐条列了）—— ' +
        '**先重排**（改 slots、存新快照）**再调一次**；`problems` 不要发给用户。\n' +
        '★★★ **`past_deadline` 是例外，必须读懂它**：某块排在**它自己的硬截止之后** = 等于没排\n' +
        '（实测踩过：明早 10:10 上课要讲的示例课程作业，被排到了**第二天晚上**）。\n' +
        '先试着**往前挪到截止之前**（截止还没到就一定能改）；\n' +
        '**实在挪不进去**（时间真的不够）⇒ **醒目地报告用户**：说清是哪件事、卡在哪（哪几个时段被什么占住）、\n' +
        '给可选方案（如"今晚先做/明早 X 点前做/接受迟交"）。**不要假装排上了，也不要只回一句"排不下"。**\n' +
        '截止**已经过了**的会进 `warnings`（不阻塞）：如实提一句即可。\n' +
        '★ `warnings` 不阻塞，但**也要处理**：`violates_rule`（软偏好）⇒ 重排避开，' +
        '或用户明确同意后把 `allow: [规则id]` 写进快照正文；`water_class`（水课）⇒ ' +
        '可用但**不建议**，只排不费脑的活；`loop` ⇒ 别再重排了。\n' +
'★ **短块（十几分钟）不是问题**，不要并块 —— 取包裹、线上提交这类本来就该单列；' +
        '**课间才是禁止**（`in_class_gap` 进 `problems`，无豁免）。',
      parameters: obj({
        days: {
          type: 'number',
          description: '只展开前 N 天（默认 3；计算仍按 7 天）。用户说「这周/整周」时给 7。',
        },
        kind: {
          type: 'string',
          enum: ['plan', 'schedule', 'todo'],
          description: 'plan=规划（不含课）；schedule=日程（含课）；todo=待办两张表',
        },
      }, []),
      output: textOutput(),
      async execute(args) {
        return await run(['brief', '--kind', String(args?.kind || 'plan'),
                          '--days', String(args?.days || 3)]);
      },
    },
    {
      name: 'qyn_review_plan',
      description:
        '★ **排完自己审一遍再交出去**：把草稿规划送进来，报出 ' +
        '`撞课 / 时段重叠 / 课间 / 规则时段 / 漏排`。' +
        '**只报不改、不落盘。** 有 `conflicts` 就**重排**（regen）再回答 —— ' +
        '**用户看到的规划必须是干净的**，冲突不要写给用户看。\n' +
        '★ 它查五类：**撞课**（含水课单独降级为警告）、**时段重叠**、**课间**（同一天两节课之间、' +
        '空隙 <60 分钟 ⇒ 冲突，改教室/转场没时间写东西）、**规则的 `no_slots` 时段**' +
        '（`constraint` ⇒ 冲突、`preference` ⇒ 警告）、**漏排**（当天有 DDL 却没排）、\n' +
        '**排在自己的硬截止之后**（`past_deadline` ⇒ 冲突，等于没排；跨过截止 ⇒ `crosses_deadline` 警告）。\n' +
        '★ 有 `conflicts` 或 `warnings` 都**重排**再交出去；确实排不下才报告。\n' +
        '`unscheduled` 里标「无 DDL，可后补」的只是提示，不阻塞。',
      parameters: obj({
        slots: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: '草稿的时段数组：[{date:"YYYY-MM-DD", time:"HH:MM-HH:MM", task:"任务名"}, …]',
        },
      }, ['slots']),
      output: textOutput(),
      async execute(args) {
        const tmp = path.join(os.tmpdir(), `qyn-review-${process.pid}-${Date.now()}.json`);
        try {
          fs.writeFileSync(tmp, JSON.stringify({ slots: args?.slots || [] }, null, 2), 'utf8');
          return await run(['review', '--file', tmp]);
        } finally {
          try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响结果 */ }
        }
      },
    },
    {
      name: 'qyn_plan_snapshot',
      description: '把一份规划结果存为快照（内部留档，便于之后回看"当时是怎么排的"）。',
      parameters: obj({
        plan: {
          type: 'object',
          additionalProperties: true,
          description: '规划 JSON 对象。**`slots` 必填**（每块 {date,time,task}；brief 靠它排版，' +
                     '缺了下一轮就看不见自己排过什么）。可选 `allow:[规则id]` 记录用户同意过的破例、' +
                     '`focus`/`order` 记录你的主张。注：`context` 里的 `last_plan` 只回**前 12 块**，' +
                     '要看全的用 brief。',
        },
        triggered_by: { type: 'string', description: '触发原因，如「每日检查」' },
      }, ['plan']),
      output: textOutput(),
      async execute(args) {
        // 内核的 plan-snapshot 走 --file（避开 Windows shell 的编码问题），
        // 这里由插件代写临时文件，模型不必关心文件细节。
        const tmp = path.join(os.tmpdir(), `qyn-plan-${process.pid}-${Date.now()}.json`);
        try {
          fs.writeFileSync(tmp, JSON.stringify(args.plan, null, 2), 'utf8');
          const a = ['plan-snapshot', '--file', tmp];
          if (args.triggered_by) a.push('--triggered-by', String(args.triggered_by));
          return await run(a);
        } finally {
          try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响结果 */ }
        }
      },
    },
  ];
}

/* ────────────────────────── 插件入口 ────────────────────────── */

export function apply(ctx, config = {}) {
  // 显式配置 > $QYN_REPO_ROOT > cwd。部署侧三个单元都设了 QYN_REPO_ROOT，
  // 所以 cwd 是哪儿都不影响（这就是上面不能给 default 的原因）。
  const repoRoot = config?.repoRoot || process.env.QYN_REPO_ROOT || process.cwd();
  const python = config?.python || process.env.QYN_PYTHON || defaultPython();
  const timeoutMs = config?.timeoutMs || 60000;
  const kernel = (process.env.QYN_KERNEL || [path.join(repoRoot, 'qyn.py'), path.join(repoRoot, 'AGENT', 'qyn.py')].find(p => fs.existsSync(p)) || path.join(repoRoot, 'qyn.py'));

  const tools = ctx.get('tools');
  if (!tools || typeof tools.register !== 'function') {
    // 拿不到注册面时**不抛异常**（否则整个 profile 起不来），但必须把话说出来，
    // 不能静默变成一个"没有工具却看着正常"的插件。
    log(ctx, 'warn', `tools 服务不可用，未注册任何工具（repoRoot=${repoRoot}）`);
    return;
  }
  if (!fs.existsSync(kernel)) {
    log(ctx, 'warn', `找不到内核 ${kernel}；请把 repoRoot 指向仓库根目录`);
    return;
  }

  const specs = buildTools({ kernel, python, repoRoot, timeoutMs });
  for (const spec of specs) tools.register(spec);
  log(ctx, 'info',
      `已注册 ${specs.length} 个工具；内核=${kernel}；python=${python}`);
}

/** 供测试用的内部导出（不参与插件契约）。 */
export const __internals = {
  buildTools, runKernel, defaultPython,
  kernelPathOf: (root) => path.join(root, 'AGENT', 'qyn.py'),
};
