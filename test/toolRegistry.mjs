/**
 * 工具注册表：入参规格校验、别名归一、失败降级表、调用台账（缓存判重 / 重复失败拦截），
 * 以及执行器「先校验后执行」与 read_file 行区间读取。
 * 钉住的是框架侧的拦截能力——非法调用不能进工具实现，重复绕圈要能被关掉。
 */
import assert from 'node:assert/strict';
import {
  TOOL_DEFS, toolDef, validateCall, toolsSchema, MUTATING_TOOLS, TASK_TOOLS,
  adviceFor, makeCallLedger, contentSig,
} from '../src/workspace/toolRegistry.js';
import { makeAgentExecutor } from '../src/workspace/agentTools.js';
import { setLang, tr } from '../src/i18n.js';

setLang('zh');

/* ---------- 注册表自身的完整性 ---------- */
{
  const names = TOOL_DEFS.map(d => d.name);
  assert.equal(new Set(names).size, names.length, '工具名不得重复');
  for (const d of TOOL_DEFS) {
    assert.ok(typeof d.descKey === 'string' && d.descKey.startsWith('agent.'), d.name + ' 必须有描述文案键');
    assert.ok(tr('zh', d.descKey).length > 0, d.name + ' 的描述文案必须存在');
    assert.equal(typeof d.mutates, 'boolean');
    assert.equal(typeof d.readOnly, 'boolean');
    // 只有改盘工具需要权限档门槛；读工具若被标成 mutates 会被审核弹窗打断
    for (const k of Object.keys(d.args || {})) assert.ok(/^[a-z_]+$/.test(k), '参数名用下划线小写：' + k);
  }
  assert.deepEqual([...MUTATING_TOOLS].sort(), ['create_file', 'edit_file', 'insert_text']);
  assert.deepEqual([...TASK_TOOLS].sort(), ['set_plan', 'update_plan']);
  assert.ok(toolDef('read_file') && toolDef('nope') === null);
}

/* ---------- validateCall：非法参数一律拦住 ---------- */
{
  const unk = validateCall('hack_the_planet', {});
  assert.equal(unk.ok, false);
  assert.equal(unk.code, 'unknown_tool');
  assert.ok(unk.error.includes('hack_the_planet'), '未知工具要把名字回给模型');

  assert.equal(validateCall('read_file', {}).code, 'missing_arg', '必填缺失');
  assert.equal(validateCall('read_file', null).code, 'missing_arg', 'args 整个不给也是必填缺失');
  assert.equal(validateCall('read_file', 'main.tex').code, 'bad_args', 'args 不是对象');
  assert.equal(validateCall('read_file', { path: 42 }).code, 'bad_type', 'path 给数字');
  assert.equal(validateCall('read_file', { path: 'x'.repeat(401) }).code, 'arg_too_long');
  assert.equal(validateCall('search_files', { query: 'q'.repeat(201) }).code, 'arg_too_long', '查询长度上限迁到注册表');
  assert.equal(validateCall('create_file', { path: 'a.tex', content: 'x'.repeat(2_000_001) }).code, 'arg_too_long');
  assert.equal(validateCall('update_plan', { step: 1, status: 'finished' }).code, 'bad_enum', '状态只认枚举里的值');
  assert.equal(validateCall('set_plan', { goal: 'g', steps: '第一步' }).code, 'bad_type', 'steps 必须是数组');
  assert.equal(validateCall('set_plan', { goal: 'g', steps: Array.from({ length: 25 }, (_, i) => ({ title: i })) }).code, 'arg_out_of_range', '计划步数封顶');
}

/* ---------- validateCall：宽容的部分（别名 / 数字串 / 布尔串 / 空值） ---------- */
{
  const aliased = validateCall('search_files', { query: 'x', matchCase: true });
  assert.ok(aliased.ok);
  assert.equal(aliased.args.match_case, true, '驼峰别名归一到规范名');
  assert.equal(aliased.args.matchCase, undefined, '别名不留在参数里（否则 key 会因拼法不同而判不了重）');

  const nums = validateCall('read_file', { path: 'a.tex', from_line: '12', max_lines: 3000 });
  assert.equal(nums.ok, false, 'max_lines 超出允许范围');
  assert.equal(nums.code, 'arg_out_of_range');
  const nums2 = validateCall('read_file', { path: 'a.tex', from_line: '12' });
  assert.ok(nums2.ok && nums2.args.from_line === 12, '数字字符串按 int 收下');

  const bools = validateCall('search_files', { query: 'x', regex: 'false' });
  assert.ok(bools.ok && bools.args.regex === false, '布尔允许 "false"/"true" 串');

  const empty = validateCall('edit_file', { old_text: 'a', new_text: 'b', path: '' });
  assert.ok(empty.ok && empty.args.path === undefined, '可选参数给空串按未提供处理');

  const extra = validateCall('read_file', { path: 'a.tex', snippet: 'x' });
  assert.ok(extra.ok && extra.args.snippet === undefined, '未登记的参数丢弃而不是报错');
}

/* ---------- toolsSchema：由定义生成，不再手写第二份 ---------- */
{
  const s = toolsSchema();
  assert.ok(s.includes('- read_file {path, from_line?, max_lines?}'), '清单里的参数形状来自规格：' + s.split('\n')[1]);
  assert.ok(!s.includes('set_plan'), '默认不向模型宣告计划类动作（要开着计划才列）');
  const withTask = toolsSchema({ withTaskTools: true });
  assert.ok(withTask.includes('- set_plan {goal, steps}') && withTask.includes('- update_plan {step, status, note?}'));
  assert.equal(withTask.split('\n').length, TOOL_DEFS.length);
}

/* ---------- adviceFor：错误码 → 下一步 ---------- */
{
  assert.ok(adviceFor('old_not_found').includes('read_file'), '降级建议要给出具体下一步');
  assert.ok(adviceFor('bad_regex').length > 0);
  assert.equal(adviceFor('tool_crashed'), '', '没有纠正动作的错误码不该硬编建议');
  assert.equal(adviceFor(''), '');
  // 建议是在执行器之外按错误码拼的，没有上下文可插——文案里出现占位符就会原样露给模型
  for (const code of ['old_not_found', 'old_ambiguous', 'not_open', 'bad_regex', 'regex_unsafe', 'hidden_path',
    'file_not_found', 'too_large', 'file_exists', 'no_editor', 'missing_arg', 'bad_type', 'arg_too_long', 'bad_args']) {
    assert.ok(adviceFor(code).length > 0, '错误码要有对应建议：' + code);
    assert.ok(!/\{[a-z_]+\}/.test(adviceFor(code)), '建议文案不带占位符：' + code);
  }
}

/* ---------- contentSig：长内容尾部变化要能检出 ---------- */
{
  const head = 'x'.repeat(50000);
  assert.equal(contentSig(head), contentSig(head), '同内容同签名');
  assert.notEqual(contentSig(head + 'A'), contentSig(head + 'B'), '超长内容只改尾部也要区分');
  assert.notEqual(contentSig('abc'), contentSig('abd'));
  assert.equal(contentSig(null), contentSig(''), 'null 与空串同形');
}

/* ---------- 调用台账 ---------- */
{
  const led = makeCallLedger();
  const args = { path: 'main.tex' };
  const mk = (t) => ({ ok: true, result: t, sig: contentSig(t) });
  assert.equal(led.observe('read_file', args, mk('正文')), null, '第一次没有可对比对象');
  const dup = led.observe('read_file', args, mk('正文'));
  assert.ok(dup && dup.dupOf === 1, '同参数同内容判重并指回第一次');
  assert.equal(led.observe('read_file', args, mk('正文改过')), null, '内容变了就是新结果');
  assert.equal(led.observe('read_file', { path: 'other.tex' }, mk('正文')), null, '参数不同不共用一条缓存');
  // 键与参数顺序无关（模型两次输出顺序可能不同）
  const l2 = makeCallLedger();
  l2.observe('edit_file', { old_text: 'a', new_text: 'b' }, { ok: true, result: 'done', sig: contentSig('done') });
  assert.equal(l2.observe('edit_file', { new_text: 'b', old_text: 'a' }, { ok: true, result: 'done', sig: contentSig('done') }),
    null, '改盘工具不参与判重');
  // 同一条失败调用连着三次后被关闭
  const l3 = makeCallLedger();
  const bad = { ok: false, result: 'x' };
  assert.equal(l3.shouldBlock('edit_file', args), false);
  l3.observe('edit_file', args, bad);
  l3.observe('edit_file', args, bad);
  assert.equal(l3.shouldBlock('edit_file', args), false, '两次失败还能再试');
  l3.observe('edit_file', args, bad);
  assert.equal(l3.shouldBlock('edit_file', args), true, '第三次失败后框架拦下');
  assert.equal(l3.observe('edit_file', { ...args, old_text: '别的' }, bad), null, '换参数就不算同一条');
}

/* ---------- 执行器：非法参数进不了工具实现 ---------- */
{
  function fakeDoc(text) {
    let value = text;
    return {
      getValue: () => value,
      posFromIndex: i => ({ line: 0, ch: i }),
      replaceRange: (n, f, t) => { value = value.slice(0, f.ch) + n + value.slice(t.ch); },
    };
  }
  const tab = { id: 'main.tex', name: 'main.tex', path: 'main.tex', doc: fakeDoc('第一行\n第二行\n第三行\n第四行') };
  let snapshots = 0, created = 0;
  const executor = makeAgentExecutor({
    cm: () => tab.doc,
    tabs: () => [tab],
    activeId: () => 'main.tex',
    tabPath: tb => tb.path,
    folderIndex: () => ({ texFiles: [], bibFiles: [], textFiles: [], imageFiles: [] }),
    rootDir: () => null,
    getDiagnostics: () => [],
    beforeEdit: () => { snapshots++; },
    markDirty: () => {},
    createFile: async () => { created++; return { ok: true, msg: 'created' }; },
    openByPath: async () => ({ ok: true, msg: 'main.tex' }),
  });

  const noNew = await executor('edit_file', { old_text: '第二行' });
  assert.equal(noNew.ok, false);
  assert.equal(noNew.code, 'missing_arg');
  assert.equal(snapshots, 0, '缺参数的改动手根本没进工具，不该打快照');

  const bigText = await executor('edit_file', { old_text: 'a', new_text: 'x'.repeat(200_001) });
  assert.equal(bigText.code, 'arg_too_long', '改动手长度超限在执行器侧也拦得住');
  assert.equal(snapshots, 0);

  assert.equal(created, 0);
  const badCreate = await executor('create_file', { path: 'a.tex' });
  assert.equal(badCreate.code, 'missing_arg');
  assert.equal(created, 0, '缺 content 的建文件不该落到依赖里');

  // 行区间读取：from_line 起、max_lines 条，越界不报错只给有的部分
  const chunk = await executor('read_file', { path: 'main.tex', from_line: 2, max_lines: 2 });
  assert.ok(chunk.ok);
  assert.equal(chunk.result, '第二行\n第三行');
  const tail = await executor('read_file', { path: 'main.tex', from_line: 4 });
  assert.equal(tail.result, '第四行');
  const whole = await executor('read_file', { path: 'main.tex' });
  assert.ok(whole.result.includes('第一行') && whole.result.includes('第四行'), '不传区间仍是整篇');
  assert.equal(whole.sig, chunk.sig, '同一次读取的签名代表整篇内容，与截取的区间无关');
  const zero = await executor('read_file', { path: 'main.tex', from_line: 0 });
  assert.equal(zero.code, 'arg_out_of_range', '行号从 1 起');
}

console.log('toolRegistry: all tests passed');
