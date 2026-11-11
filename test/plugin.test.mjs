/**
 * qyn-time 插件测试 —— 用假 ctx 验证「插件 → 内核」这条链
 *
 * 为什么要有它：插件是**薄适配层**，它唯一可能出错的地方是"名字/参数接错了"
 * 或"把内核输出解析错了"。这两类错误在 DSH 里表现为"模型调了工具但结果不对"，
 * 排查成本很高。用纯 Node 断言就能提前钉住，不需要模型、不需要凭据。
 *
 * 覆盖：
 *   1. 插件契约（name / inject）
 *   2. 拿不到 tools 服务时**不抛异常**（否则整个 profile 起不来）
 *   3. 工具注册清单与参数 schema 形状（DSH 的参数 DSL：逐属性 required、
 *      对象节点要显式 additionalProperties）
 *   3b. **描述层与内核契约一致**（描述每轮都进上下文，写错等于每天骗模型）：
 *      apply 的 date 非必填、无已废弃词 too_short、brief 的课间进 problems
 *      与 loop 双分支、mark 的 status enum 对齐内核、plan_snapshot 的 slots 必填
 *   4. **真的去调内核**：读工具打真实仓库（只读、已验证无副作用），
 *      写工具打临时副本 —— ★ 写之前先证明副本 `data/` 是**真目录**且不是真实数据
 *      （部署形态下 release 的 `AGENT/data` 是软链，随会把写操作透回真机）
 *
 * 用法：node test/plugin.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, name, inject, __internals } from '../lib/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.dirname(HERE);              // AGENT/dsh/plugin/qyn-time

/** 向上找仓库根（含 AGENT/qyn.py 的那一层）—— 比数 `..` 更稳，插件挪位置也不会错。 */
function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'qyn.py'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // 独立发布仓里没有内核（qyn.py 不在本仓）⇒ 返回 null，由调用方跳过
  return null;
}
const REPO = findRepoRoot(PLUGIN_DIR);
// ★ 独立发布仓里没有内核：整份依赖内核的用例 skip，契约类用例照跑
if (!REPO) {
  console.log('[qyn-time] 未找到内核（独立仓库形态）⇒ 跳过依赖内核的用例');
  process.exit(0);
}


const results = [];
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => results.push([label, true, detail]))
    .catch((err) => results.push([label, false, err.message]));
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function fakeCtx(collector, { withTools = true } = {}) {
  return {
    get(key) {
      if (key === 'tools' && withTools) {
        return { register: (spec) => collector.push(spec) };
      }
      return undefined;
    },
    logger: { info() {}, warn() {}, error() {} },
  };
}

// ─────────────── 演练沙箱：副本里的 data/ 必须是**真目录** ───────────────
// ★ 真机事故（2026-10-15）：部署形态下 release 里的 `AGENT/data` 是软链
//   `../../../data`（CENTRAL/deploy/install-agent.sh:168）。原来的
//   `fs.cpSync(REPO/AGENT, tmp/AGENT, {recursive:true, filter})` 会把它**原样复制**成一条
//   指向真机数据的链接（实测：带 `filter` 时 cpSync 不解引用；Linux 上静默建链成功，
//   Windows 上同一行直接 EPERM）—— 于是下面所有"写临时副本"的操作全部穿透回
//   `~/qyn/agent/data`：data.json 17190B→232B、rules.json→26B、schedule.json→411B。
//   教训：**"复制到临时目录"不等于隔离** —— 副本里的 data 必须被证明是"真目录 + 不是
//   真实数据本身"，做不到就当场抛，绝不在上面写一个字节的夹具。

/** 断言 dataDir 是可以随便写的真目录。不满足直接抛（fail-fast）。 */
function assertWritableSandboxData(dataDir, realDataDir) {
  // ⚠️ readlink 只能**在确实是链接时**才调（Windows 上对真目录调它会 EINVAL，
  //    而模板串是**立刻求值**的 —— 写成 assert(cond, `…${readlinkSync()}…`) 会误报）。
  if (fs.lstatSync(dataDir).isSymbolicLink()) {
    throw new Error(
      `★ 沙箱数据目录是软链（${dataDir} -> ${fs.readlinkSync(dataDir)}）—— ` +
      '写它会穿透到真机数据，拒绝继续');
  }
  const real = fs.realpathSync(dataDir);
  assert(real !== fs.realpathSync(realDataDir),
         `★ 沙箱数据目录与真实数据是同一路径：${real}`);
  if (process.platform !== 'win32') {
    const a = fs.statSync(dataDir);
    const b = fs.statSync(realDataDir);
    assert(a.dev !== b.dev || a.ino !== b.ino,
           `★ 沙箱数据目录与真实数据是同一 inode（dev=${a.dev} ino=${a.ino}）`);
  }
}

/** 摘掉沙箱里那个指向别处的链接（软链 / junction），**只删链接本身**。 */
function detachSandboxLink(linkPath) {
  try {
    fs.unlinkSync(linkPath);       // POSIX 软链 / Windows 文件符号链接
    return;
  } catch {
    // Windows 目录联接（junction）拒绝 unlink ⇒ 用 rmdir 删重解析点本身；
    // 对非空真目录它会报错（绝不删数据），正是我们要的语义。
    fs.rmdirSync(linkPath);
  }
}

/**
 * 复制仓库到临时沙箱，并把副本里的 `AGENT/data` 物化成**真目录**。
 * 返回沙箱的数据目录 —— 调用方只该往它里面写。
 */
function copyRepoToSandbox(tmpRoot) {
  // ★ `dereference: true` 不可省：副本必须是**真目录树**。
  //   实测（同一个 junction/软链）：`{recursive:true}` 会被解引用成真目录，但**一旦带上
  //   `filter`，cpSync 就改成"把链接原样复制"** —— Windows 上直接 EPERM，Linux 上会静默
  //   建出一个指向真机数据的链接（2026-10-15 事故的成因）。所以这里显式解引用，
  //   不把"复制是不是会解链"交给默认行为去赌。
  fs.cpSync(path.join(REPO, 'AGENT'), path.join(tmpRoot, 'AGENT'),
            { recursive: true, dereference: true,
              filter: (src) => !src.includes('__pycache__') });
  const realData = path.join(REPO, 'AGENT', 'data');
  const dstData = path.join(tmpRoot, 'AGENT', 'data');
  assert(fs.existsSync(dstData), `沙箱里没有 data 目录（${dstData}）—— 复制失败了，拒绝继续`);
  if (fs.lstatSync(dstData).isSymbolicLink()) {
    // 链接（部署形态下 cpSync 会把 release 里的 `AGENT/data` 带进来，且指向真实数据）
    // ⇒ 摘掉链接，再用**真实内容**铺一份真目录：副本从此自己就是一份数据，写它谁也伤不到。
    detachSandboxLink(dstData);
    fs.cpSync(fs.realpathSync(realData), dstData,
              { recursive: true, dereference: true });
  }
  assertWritableSandboxData(dstData, realData);
  return dstData;
}

// ────────────────────────────── 用例 ──────────────────────────────

async function main() {
  // 1) 插件契约
  await check('插件契约（name / inject / apply）', async () => {
    assert(name === 'qyn-time', `name 应为 qyn-time，实际 ${name}`);
    assert(Array.isArray(inject) && inject.includes('tools'),
           `inject 里应包含 tools，实际 ${JSON.stringify(inject)}`);
    assert(typeof apply === 'function', 'apply 未导出为函数');
    return `name=${name} inject=${JSON.stringify(inject)}`;
  });

  // 2) 缺 tools 服务时不抛异常
  await check('无 tools 服务时降级而不抛异常', async () => {
    const empty = [];
    apply(fakeCtx(empty, { withTools: false }), { repoRoot: REPO });
    assert(empty.length === 0, '本不该注册任何工具');
    return '未注册工具且未抛异常（profile 仍能起来）';
  });

  // 3) 注册清单与参数形状
  const specs = [];
  await check('注册工具清单与参数 DSL 形状', async () => {
    apply(fakeCtx(specs), { repoRoot: REPO });
    assert(specs.length === 12, `应注册 12 个工具，实际 ${specs.length}`);

    const names = specs.map((s) => s.name).sort();
    const want = ['qyn_anomalies', 'qyn_apply', 'qyn_brief', 'qyn_history', 'qyn_mark',
                  'qyn_plan_snapshot', 'qyn_review_plan', 'qyn_sessions', 'qyn_show', 'qyn_state',
                  'qyn_sync', 'qyn_week'];
    assert(JSON.stringify(names) === JSON.stringify(want),
           `工具名不匹配\n实际 ${JSON.stringify(names)}\n期望 ${JSON.stringify(want)}`);

    for (const s of specs) {
      assert(typeof s.description === 'string' && s.description.length > 10,
             `${s.name} 缺 description（模型靠它决定要不要调用）`);
      // ★ 回归断言：parameters 必须是**标准 JSON Schema 的对象根**。
      //   踩过的坑：注册裸对象时 DSH 会把 parameters **原样透传**给上游（它不做
      //   DSL→JSON Schema 转换，那是 defineTool 的活）。写成 `{属性: {...}}` 会得到
      //   `type: null`，真机报 400 "schema must be a JSON Schema of 'type: object'"。
      assert(s.parameters && s.parameters.type === 'object',
             `${s.name} 的 parameters 必须是 {\"type\":\"object\"} 根，否则上游 400`);
      assert(s.parameters.properties && typeof s.parameters.properties === 'object',
             `${s.name} 的 parameters 缺 properties`);
      assert(s.output && s.output.schema, `${s.name} 缺 output.schema（宿主必填）`);
      assert(typeof s.output.render === 'function', `${s.name} 缺 output.render`);
      assert(typeof s.execute === 'function', `${s.name} 缺 execute`);
      // 对象型**属性**必须显式 additionalProperties
      for (const [pname, p] of Object.entries(s.parameters.properties)) {
        if (p.type === 'object') {
          assert('additionalProperties' in p,
                 `${s.name}.${pname} 是 object 但没写 additionalProperties`);
        }
      }
      // required 必须是数组（标准 JSON Schema），不能是逐属性 required: true
      if (s.parameters.required !== undefined) {
        assert(Array.isArray(s.parameters.required),
               `${s.name}.parameters.required 必须是数组`);
      }
      for (const [pname, p] of Object.entries(s.parameters.properties)) {
        assert(p.required === undefined,
               `${s.name}.${pname} 用了逐属性 required:true —— 那是 defineTool 的 DSL，裸注册时无效`);
      }
    }
    return `12 个工具：全部对象根 + properties/required 数组，output/execute 齐全`;
  });

  // 3b) ★ 描述层与内核契约一致 —— 防「常驻描述漂移」
  //   描述是**每轮都进上下文**的东西，写错等于每天都在骗模型，而它不报错、只在
  //   行为上表现成"模型总写错形状"。所以这里测的不是行为，是"描述说的 = 实现做的"。
  //   事实源：AGENT/qyn.py（内核）。★ 每条都能在"把描述改回旧文案"时失败，见下方注释。
  await check('描述层与内核契约一致（防常驻描述漂移）', async () => {
    const pick = (n) => specs.find((s) => s.name === n);
    for (const n of ['qyn_apply', 'qyn_brief', 'qyn_mark', 'qyn_plan_snapshot']) {
      assert(pick(n), `${n} 不在注册清单里`);
    }
    const applySpec = pick('qyn_apply');
    const briefSpec = pick('qyn_brief');
    const markSpec = pick('qyn_mark');
    const snapSpec = pick('qyn_plan_snapshot');

    // ① qyn_apply：`date` **不再**是必填（内核口径：只在有硬截止时给，没有就别写字段）。
    //    失败验证：把 upsert 描述改回旧文案「必须有 task 与 date」⇒ 这里立刻红。
    //    注：描述挂在 `upsert` 属性上（`items` 只有 additionalProperties）。
    const upsertDesc = applySpec.parameters.properties.list.properties.upsert.description;
    assert(/date/.test(upsertDesc) && /硬截止/.test(upsertDesc),
           `qyn_apply 没写清 date 只在**有硬截止**时给：${upsertDesc}`);
    assert(!/必须有\s*task\s*与\s*date/.test(upsertDesc),
           `qyn_apply 又把 date 写成必填了（会诱导模型编 DDL）：${upsertDesc}`);
    assert(!(applySpec.parameters.required || []).includes('date'),
           'qyn_apply 的顶层 required 里出现了 date');

    // ② 已废弃词守卫：`too_short` 内核早就不产出了，描述里再提，模型就会去处理一个
    //    不存在的警告。失败验证：把 brief 描述改回旧文案（里面有 `too_short`）⇒ 红。
    const stale = specs.filter((s) => /too_short/.test(s.description));
    assert(stale.length === 0,
           `描述里出现已废弃的 too_short：${stale.map((s) => s.name).join(', ')}`);

    // ③ qyn_brief：课间 `in_class_gap` 是**阻塞**（进 problems，无豁免），不是 warnings；
    //    `loop` 的新语义 = 无阻塞照发正文 / 有阻塞（ok=false 且 kind=loop）才拦。
    //    失败验证：旧文案是「`in_class_gap`（课间）⇒ 避开」+「若 `kind=loop`：停下」⇒ 三条全红。
    const bd = briefSpec.description;
    assert(/in_class_gap`?\s*进\s*`?problems/.test(bd),
           'qyn_brief 没把 in_class_gap 归进 problems（课间是硬禁止，不是警告）');
    assert(/warnings`[\s\S]{0,80}loop[\s\S]{0,80}照发/.test(bd),
           'qyn_brief 没写「warnings 里的 loop：这次照发」（无阻塞不该拦）');
    assert(/ok\s*=\s*false[\s\S]{0,40}kind\s*=\s*loop/.test(bd),
           'qyn_brief 没写「ok=false 且 kind=loop 才停下」（旧文案一律叫停 = 谎报排不下）');

    // ④ qyn_mark 的 `status` enum 必须与内核 `choices` **完全一致** —— 内核是唯一事实。
    //    这里直接从 AGENT/qyn.py 解析，内核改了而插件没跟上就红（`skipped` 就是这么来的）。
    const kernelSrc = fs.readFileSync(path.join(REPO, 'qyn.py'), 'utf8');
    const km = kernelSrc.match(/"--status"[\s\S]{0,200}?choices\s*=\s*\[([^\]]*)\]/);
    assert(km, '没能从 AGENT/qyn.py 解析出 mark --status 的 choices —— 解析器要跟着内核改');
    const kernelChoices = [...km[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
    const pluginChoices = [...(markSpec.parameters.properties.status.enum || [])].sort();
    assert(JSON.stringify(pluginChoices) === JSON.stringify(kernelChoices),
           `qyn_mark 的 status enum 与内核 choices 不一致\n` +
           `插件 ${JSON.stringify(pluginChoices)}\n内核 ${JSON.stringify(kernelChoices)}`);
    assert(!pluginChoices.includes('skipped') && !kernelChoices.includes('skipped'),
           'mark 里还有已废弃的 skipped（内核 schema 不认，一定失败）');

    // ⑤ qyn_plan_snapshot：`slots` 必填（旧文案"结构自由，由内核原样落库"是错的）。
    const planDesc = snapSpec.parameters.properties.plan.description;
    assert(/slots/.test(planDesc) && /必填/.test(planDesc),
           `qyn_plan_snapshot 没写明 slots 必填：${planDesc}`);

    return `apply.date 非必填 / 无 too_short / brief 课间进 problems + loop 双分支 / ` +
           `mark enum 对齐内核(${kernelChoices.join(',')}) / snapshot.slots 必填`;
  });

  // 4) 真调内核：读工具打真实仓库
  await check('读工具真调内核（qyn_state / qyn_sessions / qyn_anomalies）', async () => {
    const state = await specs.find((s) => s.name === 'qyn_state').execute({}, {});
    // ★ 课次与注册表**分家**：state 只给"最近一节 + 总量"，课次清单统一走 qyn_sessions
    assert(typeof state.class_count === 'number', 'qyn_state 缺 class_count');
    assert(state.next_class === null || typeof state.next_class === 'object',
           'qyn_state 缺 next_class');
    assert(!('dated_sessions' in state) && !('periods' in state),
           '★ state 不该再返回整份课表与作息表 —— 那是与 qyn_sessions 的重复投递');
    assert(Array.isArray(state.periodic_tasks), 'qyn_state 缺周期任务');
    // ★ 只给**活跃注册**（日期已过的已滚出、对模型隐藏），且不含课次
    assert(Array.isArray(state.active), 'qyn_state 缺 active（活跃注册）');
    assert(!state.active.some((d) => d.session_key),
           '★ active 里不该再出现课次（课次已在 next_class / qyn_sessions 里）');
    assert(!('registry' in state) && !('pending_deadlines' in state),
           '★ 不该再把全量/未过滤的清单交出去 —— 过期注册必须对模型隐藏');

    const hist = await specs.find((s) => s.name === 'qyn_history').execute({ days: 30 }, {});
    assert(hist && Array.isArray(hist.entries) && Array.isArray(hist.unfinished),
           'qyn_history 结构不对');
    // ★ 结构上守住"不用周计算时间"：视图里不该有周字段
    assert(!('current_week' in state) && !('upcoming_windows' in state),
           '★ 状态里还有周字段（current_week / upcoming_windows），与"不用周"冲突');
    // ★ 更进一步：**周次这种值根本不该出现**（2026-W41 之类）。它曾经躺在 data.json
    //   的 meta 里：没人读，却是内核**唯一一处周号计算**，也是"拿它推周次"的入口。
    assert(!/\d{4}-W\d{2}/.test(JSON.stringify(state)),
           '★ 视图里出现了周次值（YYYY-Www）—— 周计数必须退场');

    const sess = await specs.find((s) => s.name === 'qyn_sessions').execute({ days: 7 }, {});
    assert(sess && Array.isArray(sess.sessions) && Array.isArray(sess.due),
           'qyn_sessions 结构不对');
    assert(!/\d{4}-W\d{2}/.test(JSON.stringify(sess)), '★ 课表视图里出现了周次值');
    assert(sess.days === 7, 'qyn_sessions 没按 days 取窗口');
    // ★ 课次精简形状 + due 里不含课次（否则同一件事投两遍）
    if (sess.sessions.length) {
      const s0 = sess.sessions[0];
      assert(s0.date && s0.course, `课次缺必要字段：${JSON.stringify(s0)}`);
      assert(!('session_key' in s0) && !('priority' in s0),
             `课次应精简（不带注册表字段）：${JSON.stringify(s0)}`);
    }
    assert(!sess.due.some((d) => d.session_key),
           '★ sessions.due 里不该含课次 —— 课次已在 sessions 里给过了');

    const anom = await specs.find((s) => s.name === 'qyn_anomalies').execute({}, {});
    assert(anom && Array.isArray(anom.anomalies), 'qyn_anomalies 结构不对');
    // ★ 只断言**结构**，不断言"当前数据里有哪几类异常" —— 读取用例打的是**真实仓库**，
    //   那种断言会随用户的真实使用而变质（已踩过：用户删掉 rule-001 之后，
    //   "应检出 rule_scope_mismatch" 就挂了，而代码其实完全正常）。
    assert(typeof anom.clean === 'boolean', 'qyn_anomalies 缺 clean');
    assert(anom.counts && typeof anom.counts === 'object', 'qyn_anomalies 缺 counts');
    const kinds = [...new Set(anom.anomalies.map((a) => a.type))];
    return `课次=${state.class_count} 节 活跃注册=${state.active.length} 条` +
           ` 异常=${kinds.length} 项`;
  });

  // 5) 真调内核：写工具打临时副本（不碰真实数据）
  await check('写工具真调内核并落盘（临时副本，data/ 是真目录）', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qyn-plugin-'));
    try {
      // ★ 守门在这里：副本 data/ 被证明是真目录、且不是真实数据，之后才允许写夹具。
      //   部署形态（release 里 AGENT/data === 软链）下这一步会把链接换成真目录。
      const ddir = copyRepoToSandbox(tmpRoot);
      // ★ 用**干净夹具**覆盖真实数据 —— 否则用例会随真实使用而漂移。
      //   实测踩到：库里已登记了真实课表，这里的 add 立刻撞上"2026-10-14 5-8 已经有课"。
      fs.writeFileSync(path.join(ddir, 'rules.json'),
                       JSON.stringify({ planning_rules: [] }), 'utf8');
      fs.writeFileSync(path.join(ddir, 'data.json'),
                       JSON.stringify({ registry: [],
                                        meta: { last_updated: '' } }), 'utf8');
      fs.writeFileSync(path.join(ddir, 'schedule.json'),
                       JSON.stringify({ semester: '', periods: {},
                                        dated_sessions: [], periodic_tasks: [] }), 'utf8');
      const tmpSpecs = [];
      apply(fakeCtx(tmpSpecs), { repoRoot: tmpRoot });

      const applyTool = tmpSpecs.find((s) => s.name === 'qyn_apply');

      // ① 注册一条（原 qyn_set_deadline 的能力已并入 apply）
      const created = await applyTool.execute({
        list: { upsert: [{ task: '插件冒烟', date: '2026-12-01', priority: 'high',
                           detail: { effort: '两天' } }] },
      }, {});
      assert(created.ok === true && created.written.includes('data.json'),
             `apply 注册失败：${JSON.stringify(created)}`);

      // ② 同名再 apply = **整条替换**（不新增；detail 也换成新的，不合并旧字段）
      const updated = await applyTool.execute({
        list: { upsert: [{ task: '插件冒烟', date: '2026-12-03',
                           detail: { effort: '三天' } }] },
      }, {});
      // ★ 报告**按集合收在一个 `report` 里**（report.list / report.schedule / report.rules）。
      //   曾经 list 的报告单独放在顶层 `list` 键，而描述写着"必须看 report" ——
      //   于是只改注册表时 report 是空的。这里连"键在不在"一起守。
      assert(updated.report && updated.report.list, `report 里缺 list：${JSON.stringify(updated)}`);
      assert(updated.report.list.updated === 1 && updated.report.list.added === 0,
             `同名再写应为 updated：${JSON.stringify(updated.report)}`);
      assert(updated.list === undefined, 'report 之外的顶层 list 键应当已经不存在（避免两条路径）');

      // ③ 保守匹配仍由 mark 守（这条工具保留：高频、参数极简）
      const mark = tmpSpecs.find((s) => s.name === 'qyn_mark');
      const rejected = await mark.execute({ task: '插件冒烟v2', status: 'done' }, {});
      assert(rejected.ok === false, '名称不一致竟然通过了');
      assert(Array.isArray(rejected.known_tasks) && rejected.known_tasks.includes('插件冒烟'),
             `拒绝时未带回 known_tasks：${JSON.stringify(rejected)}`);

      // ④ 整批导入课表（原 set_schedule 的 replace）—— 多模态录入走的就是这条路
      const imported = await applyTool.execute({
        schedule: {
          periods: { 1: '08:00-08:45', 2: '08:55-09:40' },
          dated_sessions: [
            { date: '2026-10-12', periods: '1-2', course: '示例课程H', location: '示例教室X1' },
            { date: '2026-10-14', periods: '1-2', course: '示例课程E', location: '示例教室X1' },
          ],
        },
      }, {});
      assert(imported.ok === true && imported.written.includes('schedule.json'),
             `整批导入失败：${JSON.stringify(imported)}`);
      let schedFile = JSON.parse(
        fs.readFileSync(path.join(tmpRoot, 'AGENT/data/schedule.json'), 'utf8'));
      assert(schedFile.dated_sessions.length === 2, JSON.stringify(schedFile.dated_sessions));
      assert(schedFile.dated_sessions[1].location === '示例教室X1', '地点丢了');

      // ⑤ ★ 增量改一节：模型只写要改的那条，**不必把整份课表原样搬回**
      const patched = await applyTool.execute({
        schedule: { sessions: { upsert: [{ date: '2026-10-14', periods: '1-2',
                                           course: '示例课程E', location: '新楼X101' }] } },
      }, {});
      assert(patched.ok === true, `增量改课表失败：${JSON.stringify(patched)}`);
      schedFile = JSON.parse(
        fs.readFileSync(path.join(tmpRoot, 'AGENT/data/schedule.json'), 'utf8'));
      assert(schedFile.dated_sessions.length === 2, '增量写法不该新增条目');
      const moved = schedFile.dated_sessions.find((s) => s.date === '2026-10-14');
      assert(moved.location === '新楼X101', `地点没改到：${JSON.stringify(moved)}`);

      // ⑥ 加/删周期任务（原 set_periodic / remove_periodic）
      await applyTool.execute({ schedule: { periodic_tasks: { upsert: [
        { task: '示例课程A作业', follow_course: '示例课程A', due_time: '23:59' }] } } }, {});
      let st = await tmpSpecs.find((s) => s.name === 'qyn_state').execute({}, {});
      assert(st.periodic_tasks.includes('示例课程A作业'), JSON.stringify(st.periodic_tasks));
      await applyTool.execute({ schedule: { periodic_tasks: { remove: ['示例课程A作业'] } } }, {});
      st = await tmpSpecs.find((s) => s.name === 'qyn_state').execute({}, {});
      assert(!st.periodic_tasks.includes('示例课程A作业'), JSON.stringify(st.periodic_tasks));

      // ⑦ 加/删规则（原 set_rule）
      await applyTool.execute({ rules: { planning_rules: { upsert: [
        { id: 'rule-999', kind: 'preference', condition: '中午没课', body: '优先数学' }] } } }, {});
      st = await tmpSpecs.find((s) => s.name === 'qyn_state').execute({}, {});
      assert(st.planning_rules.some((r) => r.id === 'rule-999'), '规则没加进去');
      await applyTool.execute({ rules: { planning_rules: { remove: ['rule-999'] } } }, {});
      st = await tmpSpecs.find((s) => s.name === 'qyn_state').execute({}, {});
      assert(!st.planning_rules.some((r) => r.id === 'rule-999'), '规则没删掉');

      // ⑧ 非具体日期一律拒绝（"不许用周"的守门测试）
      const badDate = await applyTool.execute({
        schedule: { dated_sessions: [{ date: '第6周', periods: '1-2', course: 'X' }] },
      }, {});
      assert(badDate.ok === false, `非具体日期竟然通过：${JSON.stringify(badDate)}`);

      // ⑨ 写错键名要被挡（帮模型尽早发现自己写错了字段，而不是静默忽略）
      const badKey = await applyTool.execute({ schedule: { sessons: [] } }, {});
      assert(badKey.ok === false && /不认识/.test(badKey.error),
             `错键竟然通过：${JSON.stringify(badKey)}`);

      // ⑩ show 取完整结构体；state 只给列表视图
      const showTool = tmpSpecs.find((s) => s.name === 'qyn_show');
      const shown = await showTool.execute({ task: '插件冒烟' }, {});
      assert(shown.entry.detail.effort === '三天',
             `show 没取回 detail（或是旧 detail 被合并了）：${JSON.stringify(shown)}`);
      const view = st.active.find((d) => d.task === '插件冒烟');
      assert(view && view.has_detail === true && view.detail === undefined,
             `state 应是列表视图：${JSON.stringify(view)}`);

      const data = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'AGENT/data/data.json'), 'utf8'));
      const hit = data.registry.filter((d) => d.task === '插件冒烟');
      assert(hit.length === 1 && hit[0].date === '2026-12-03',
             `落盘内容不对：${JSON.stringify(hit)}`);
      return '唯一写入口 apply：注册/整条替换/整批导入/★增量改课表/周期任务/规则 全通；错日期与错键被拒';
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // 6) 内核失败也要变成结构化结果（而不是一句 "command failed"）
  await check('内核报错被翻译成结构化 JSON', async () => {
    const broken = [];
    apply(fakeCtx(broken), { repoRoot: path.join(os.tmpdir(), '不存在的仓库') });
    assert(broken.length === 0, '内核缺失时不该注册工具（应记警告后返回）');
    return '内核路径不存在时记警告、不注册工具、不抛异常';
  });

  // ── 3c. repoRoot 的解析顺序：$QYN_REPO_ROOT 必须真的生效 ─────────────────────
  // 实测踩过：Config 里给 repoRoot 写了 zod default(process.cwd()) ⇒
  // `config?.repoRoot || process.env.QYN_REPO_ROOT || process.cwd()` 里环境变量成了
  // **死分支**。服务的工作目录一改（cwd 不再是仓库根），所有轮次的 qyn 工具就都没注册，
  // 而测试都在仓库根里跑、按 cwd 也能找到内核 ⇒ 全绿却线上是坏的。
  await check('cwd 不是仓库根时，$QYN_REPO_ROOT 仍让 12 个工具注册上', async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'qyn-cwd-'));
    const saved = process.env.QYN_REPO_ROOT;
    process.env.QYN_REPO_ROOT = REPO;
    const names = [];
    const ctx = {
      get: (n) => (n === 'tools' ? { register: (spec) => names.push(spec.name) } : undefined),
      logger: () => ({ info() {}, warn() {}, debug() {} }),
    };
    const cwd0 = process.cwd();
    try {
      process.chdir(elsewhere);                 // ★ cwd 不是仓库根
      await apply(ctx, {});                     // 不显式给 repoRoot
    } finally {
      process.chdir(cwd0);
      if (saved === undefined) delete process.env.QYN_REPO_ROOT;
      else process.env.QYN_REPO_ROOT = saved;
    }
    assert(names.length === 12, `注册到 ${names.length} 个（应为 12）—— 环境变量又被默认值盖住了？`);
    return 'cwd 在别处，靠 $QYN_REPO_ROOT 也找到了内核并注册 12 个工具';
  });

  // ── 输出 ──
  console.log('='.repeat(66));
  console.log('  qyn-time 插件测试（假 ctx + 真调内核）');
  console.log('='.repeat(66));
  console.log(`插件: ${name}   仓库: ${REPO}`);
  console.log('-'.repeat(66));
  for (const [label, ok, detail] of results) {
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`);
    console.log(`       ${detail}`);
  }
  const failed = results.filter((r) => !r[1]);
  console.log('-'.repeat(66));
  console.log(`合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('测试自身异常:', err);
  process.exit(2);
});
