/**
 * AI Agent 工具层：```tool 块解析、工具执行器（读文件 / 搜索 / 改文档）、项目简报。
 * 全部用 fake 依赖跑，不碰浏览器 API；钉住的是「协议与安全守则」——
 * old_text 不唯一必须拒绝、工具结果必须截断、解析坏块不能炸。
 */
import assert from 'node:assert/strict';
import { parseToolCalls, stripToolBlocks, makeAgentExecutor, outlineOf, TOOL_RESULT_MAX_CHARS } from '../src/workspace/agentTools.js';
import { agentProjectBrief } from '../src/workspace/chatContext.js';
import { setLang, tr } from '../src/i18n.js';

setLang('zh');

// CodeMirror 最小面 + 可变文档（edit_file 真的会改它）
function fakeCm(text, opts = {}) {
  let value = text;
  const cm = {
    getValue: () => value,
    setValue: v => { value = v; },
    getSelection: () => opts.selection || '',
    getCursor: () => opts.cursor || { line: 0, ch: value.length },
    usedReplaceSelection: false,
    replaceSelection: v => { value += v; cm.usedReplaceSelection = true; },
    posFromIndex: i => {
      const lines = value.split('\n');
      let n = 0;
      for (let l = 0; l < lines.length; l++) {
        const len = lines[l].length + 1;
        if (n + len > i) return { line: l, ch: i - n };
        n += len;
      }
      return { line: lines.length - 1, ch: lines[lines.length - 1].length };
    },
    replaceRange: (newText, from, to) => {
      const idx = (p) => {
        const lines = value.split('\n');
        let n = 0;
        for (let l = 0; l < p.line; l++) n += lines[l].length + 1;
        return n + p.ch;
      };
      const a = idx(from), b = idx(to);
      value = value.slice(0, a) + newText + value.slice(b);
    },
  };
  return cm;
}

function fakeTab(path, text, id = path) {
  return { id, name: path, path, kind: 'tex', doc: fakeCm(text) };
}

function makeDeps({ cmText = '', tabs = [], folderIndex = {}, activeId = null, diagnostics = [], cmOpts = {}, disk = null, approval } = {}) {
  const cm = fakeCm(cmText, cmOpts);
  let edited = false;
  const seen = { beforeTabs: [], dirtied: [], diskReads: [] };
  // disk 给的是「磁盘兜底能读到的文件」表：路径段 → 文本，用来验证隐藏文件根本不去读
  const rootDir = disk ? {
    async getDirectoryHandle(name) { seen.diskReads.push('dir:' + name); return rootDir; },
    async getFileHandle(name) {
      seen.diskReads.push(name);
      if (!(name in disk)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      const text = disk[name];
      return { getFile: async () => ({ size: text.length, text: async () => text }) };
    },
  } : null;
  return {
    cm,
    edits: () => edited,
    seen,
    executor: makeAgentExecutor({
      cm: () => cm,
      tabs: () => tabs,
      activeId: () => activeId || (tabs[0] && tabs[0].id),
      tabPath: tb => tb.path,
      folderIndex: () => folderIndex,
      rootDir: () => rootDir,
      getDiagnostics: () => diagnostics,
      beforeEdit: (tb) => { edited = true; seen.beforeTabs.push(tb ? tb.path : null); },
      markDirty: (tb) => seen.dirtied.push(tb.path),
      createFile: async () => ({ ok: true, msg: 'created' }),
      openByPath: async () => ({ ok: false, msg: 'not found' }),
      ...(approval ? { approval: () => approval } : {}),
    }),
  };
}

// ---------- parseToolCalls：协议解析 ----------
assert.equal(parseToolCalls('没有工具的普通回答').calls.length, 0);
{
  const text = '先看一下文件：\n```tool\n{"tool":"read_file","args":{"path":"main.tex"}}\n```\n随后继续。';
  const { calls, bad } = parseToolCalls(text);
  assert.equal(bad.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'read_file');
  assert.equal(calls[0].args.path, 'main.tex');
  // 同轮多个调用
  const multi = parseToolCalls('```tool\n{"tool":"a"}\n```\n中间说明\n```tool\n{"tool":"b","args":{"k":1}}\n```');
  assert.equal(multi.calls.length, 2);
  assert.deepEqual(multi.calls[1].args, { k: 1 });
}
// 坏 JSON 进 bad（回传给模型修正），绝不抛异常
{
  const { calls, bad } = parseToolCalls('```tool\n{oops}\n```');
  assert.equal(calls.length, 0);
  assert.equal(bad.length, 1);
}
// 缺 tool 字段也算坏块
assert.equal(parseToolCalls('```tool\n{"name":"x"}\n```').bad.length, 1);

// stripToolBlocks：闭合与流式未闭合都要剥掉（块位置可能留下空行，属正常）
assert.ok(stripToolBlocks('前\n```tool\n{"tool":"a"}\n```\n后').includes('```tool') === false);
assert.ok(stripToolBlocks('前\n```tool\n{"tool":"a"}\n```\n后').startsWith('前'));
assert.equal(stripToolBlocks('正文\n```tool\n{"tool":"a"'), '正文');

// ---------- list_files：打开标签 + 文件夹索引，活动标签有标记 ----------
{
  const { executor } = makeDeps({
    tabs: [fakeTab('main.tex', 'x', 1), fakeTab('refs.bib', 'y', 2)],
    activeId: 1,
    folderIndex: { texFiles: [{ path: 'ch1/intro.tex', source: '' }], bibFiles: [], textFiles: [], imageFiles: [] },
  });
  const r = await executor('list_files', {});
  assert.ok(r.ok);
  assert.ok(r.result.includes('main.tex'));
  assert.ok(r.result.includes(tr('zh', 'agent.filesActive')));
  assert.ok(r.result.includes('ch1/intro.tex'));
}

// ---------- read_file：打开标签实时内容 > 文件夹索引 > 不存在 ----------
{
  const { executor } = makeDeps({
    cmText: '编辑中的内容',
    tabs: [fakeTab('main.tex', '', 1)],
    activeId: 1,
    folderIndex: { texFiles: [{ path: 'ch1.tex', source: '磁盘上的内容' }], bibFiles: [], textFiles: [], imageFiles: [] },
  });
  const live = await executor('read_file', { path: 'main.tex' });
  assert.ok(live.ok && live.result.includes('编辑中的内容'), '活动标签必须读编辑器实时值');
  const disk = await executor('read_file', { path: 'ch1.tex' });
  assert.ok(disk.ok && disk.result === '磁盘上的内容');
  const miss = await executor('read_file', { path: 'nope.tex' });
  assert.ok(!miss.ok && miss.result.includes('nope.tex'));
}

// ---------- search_files：命中带 path:line 前缀，无命中也 ok ----------
{
  const { executor } = makeDeps({
    tabs: [fakeTab('a.tex', 'hello world\nfoo', 1), fakeTab('b.tex', 'hello again', 2)],
  });
  const hit = await executor('search_files', { query: 'hello' });
  assert.ok(hit.ok);
  assert.ok(hit.result.includes('a.tex:1'));
  assert.ok(hit.result.includes('b.tex:1'));
  const none = await executor('search_files', { query: 'zzz' });
  assert.ok(none.ok);
  const badRe = await executor('search_files', { query: '(', regex: true });
  assert.ok(!badRe.ok);
}

// ---------- get_diagnostics / read_selection ----------
{
  const { executor } = makeDeps({ diagnostics: [{ line: 3, msg: '未闭合的环境' }] });
  const d = await executor('get_diagnostics', {});
  assert.ok(d.ok && d.result.includes('未闭合的环境'));
  const { executor: ex2, cm } = makeDeps({ cmText: 'abc' });
  cm.getSelection = () => '选中的句子';
  const sel = await ex2('read_selection', {});
  assert.equal(sel.result, '选中的句子');
}

// ---------- edit_file：old_text 必须存在且唯一；修改前必须先快照 ----------
{
  const { executor, cm, edits } = makeDeps({ cmText: 'aaa\n独特的一行\nbbb\n独特的一行\nccc' });
  const amb = await executor('edit_file', { old_text: '独特的一行', new_text: 'X' });
  assert.ok(!amb.ok, '出现两处必须拒绝');
  assert.ok(amb.result.includes(tr('zh', 'agent.errOldAmbiguous').slice(0, 6)), '提示要说明原因');

  const miss = await executor('edit_file', { old_text: '不存在', new_text: 'X' });
  assert.ok(!miss.ok);

  assert.equal(edits(), false, '失败的编辑不该触发快照');
  const okr = await executor('edit_file', { old_text: '\n独特的一行\nbbb', new_text: '\n替换后\nbbb' });
  assert.ok(okr.ok);
  assert.equal(edits(), true, '成功修改前必须先快照');
  assert.equal(cm.getValue(), 'aaa\n替换后\nbbb\n独特的一行\nccc', '只改第一处');
}

// ---------- edit_file 带 path：改被指名的标签，不蹭活动标签 ----------
{
  const bg = fakeTab('intro.tex', 'x\n引言\ny');
  const { executor, cm, seen } = makeDeps({
    cmText: '活动文档\nAAA',
    tabs: [fakeTab('main.tex', '活动文档\nAAA'), bg],
    activeId: 'main.tex',
  });
  const r = await executor('edit_file', { path: 'intro.tex', old_text: '引言', new_text: '改后' });
  assert.ok(r.ok, '后台标签可被指名编辑');
  assert.equal(bg.doc.getValue(), 'x\n改后\ny', '改动落在被指名的文档');
  assert.equal(cm.getValue(), '活动文档\nAAA', '活动文档一个字都不该动');
  assert.deepEqual(seen.beforeTabs, ['intro.tex'], '快照要按被改标签算');
  assert.deepEqual(seen.dirtied, ['intro.tex'], '后台标签没有 change 事件，必须补脏标记');
  assert.ok(r.result.includes('intro.tex'), '结果要回显改的是哪个文件：' + r.result);

  const ghost = await executor('edit_file', { path: 'ghost.tex', old_text: 'a', new_text: 'b' });
  assert.ok(!ghost.ok);
  assert.ok(ghost.result.includes('open_file'), '未打开要提示先 open_file：' + ghost.result);

  const legacy = await executor('edit_file', { old_text: 'AAA', new_text: 'BBB' });
  assert.ok(legacy.ok, '省略 path 沿用活动编辑器');
  assert.equal(cm.getValue(), '活动文档\nBBB');
  assert.equal(seen.beforeTabs[1], null, '活动编辑器的快照仍走活动文档');
}

// ---------- insert_text 只认当前光标所在文档 ----------
{
  const bg = fakeTab('intro.tex', 'x\n引言\ny');
  const { executor, cm } = makeDeps({ cmText: '活动文档', tabs: [fakeTab('main.tex', '活动文档'), bg], activeId: 'main.tex' });
  const wrong = await executor('insert_text', { text: 'z', path: 'intro.tex' });
  assert.ok(!wrong.ok, 'path 不是活动文档时必须拒绝，否则文本落到别的文件');
  assert.ok(wrong.result.includes('edit_file'), '拒绝时要指路 edit_file：' + wrong.result);
  assert.equal(bg.doc.getValue(), 'x\n引言\ny', '被拒绝的插入不该碰任何文档');
  const same = await executor('insert_text', { text: 'z', path: 'main.tex' });
  assert.ok(same.ok, 'path 指向活动文档时放行');
  assert.equal(cm.getValue(), '活动文档z');
}


{
  const { executor, edits } = makeDeps({ cmText: 'x' });
  const r = await executor('insert_text', { text: 'y' });
  assert.ok(r.ok && r.ok === true);
  assert.equal(edits(), true);
}

// insert_text 的语义是「光标处插入」：有选区时走 replaceSelection 等于把用户选中的正文吃掉
{
  const { executor, cm } = makeDeps({ cmText: 'abc', cmOpts: { selection: 'bc', cursor: { line: 0, ch: 0 } } });
  const r = await executor('insert_text', { text: 'Z' });
  assert.ok(r.ok);
  assert.equal(cm.getValue(), 'Zabc', '选中的 bc 必须还在');
  assert.equal(cm.usedReplaceSelection, false, '不再走 replaceSelection');
}

// ---------- search_files：模型给的正则在 UI 线程逐行 exec，得挡住爆炸串与超长串 ----------
{
  const { executor } = makeDeps({ tabs: [fakeTab('main.tex', 'aaa\nbbb')] });
  const nested = await executor('search_files', { query: '(a+)+b', regex: true });
  assert.ok(!nested.ok, '嵌套量词正则直接拒绝，否则整页冻住');
  const long = await executor('search_files', { query: 'q'.repeat(201) });
  assert.ok(!long.ok, '超长查询拒绝');
  const safe = await executor('search_files', { query: 'a+', regex: true });
  assert.ok(safe.ok, '正常正则照常执行');
}

// ---------- read_file 的磁盘兜底不碰隐藏文件（宽选目录时 .env 不该成为可外发素材） ----------
{
  const { executor, seen } = makeDeps({ disk: { 'ch1.tex': '正文', 'env': 'SECRET' } });
  const hidden = await executor('read_file', { path: '.env' });
  assert.ok(!hidden.ok, '隐藏文件读不到');
  assert.equal(seen.diskReads.length, 0, '拒绝发生在打开句柄之前，根本没去读磁盘');
  const dotDir = await executor('read_file', { path: '.git/config' });
  assert.ok(!dotDir.ok, '点开头的目录同样拒绝');
  const plain = await executor('read_file', { path: 'ch1.tex' });
  assert.equal(plain.result, '正文', '普通磁盘文件照常可读');
}

// ---------- list_files：图片清单是字符串路径，别再显示成 undefined ----------
{
  const { executor } = makeDeps({ folderIndex: { imageFiles: ['fig/架构图.png', { path: 'fig/old.tex', name: 'x' }], texFiles: [], bibFiles: [], textFiles: [] } });
  const r = await executor('list_files', {});
  assert.ok(r.result.includes('fig/架构图.png'), '字符串路径原样列出：' + r.result);
  assert.ok(!r.result.includes('undefined'), '不再出现 undefined');
}

// ---------- 未知工具 / 异常工具都归一为 ok:false ----------
{
  const { executor } = makeDeps({});
  const unk = await executor('hack_the_planet', {});
  assert.ok(!unk.ok);
  assert.ok(unk.result.includes('hack_the_planet'));
}

// ---------- 大结果截断 ----------
{
  const big = 'x'.repeat(TOOL_RESULT_MAX_CHARS + 5000);
  // 活动 Tab 的读取路径走 executor 的 cm（真实环境二者同源），fake 里保持同一份文本
  const { executor } = makeDeps({ cmText: big, tabs: [fakeTab('big.tex', big, 1)], activeId: 1 });
  const r = await executor('read_file', { path: 'big.tex' });
  assert.ok(r.ok);
  assert.ok(r.result.length < TOOL_RESULT_MAX_CHARS + 200, '超长结果必须截断');
  assert.ok(r.result.includes('截断') || r.result.includes('truncated'), '截断要有说明');
}

// ---------- outlineOf / agentProjectBrief：渐进式披露，简报只放元数据 ----------
{
  const outline = outlineOf('\\section{引言}\n正文\n\\subsection{背景}\n正文');
  assert.equal(outline.length, 2);
  assert.ok(outline[0].includes('引言'));

  const selText = '这是被选中的一段很长的正文'.repeat(40);
  const cm = fakeCm('\\section{方法}\n' + '大量正文。'.repeat(500));
  cm.getSelection = () => selText;
  const brief = agentProjectBrief({
    cm: () => cm,
    tabs: [{ id: 1, name: 'main.tex', path: 'main.tex', doc: cm }],
    activeId: () => 1,
    tabPath: tb => tb.path,
    diagnostics: [{ line: 1, msg: 'x' }],
  });
  assert.ok(brief.includes('main.tex'));
  assert.ok(brief.includes('方法'), '大纲要在');
  assert.ok(brief.includes('1'), '诊断数要在');
  // 选区只报长度：正文与选区全文都不能进简报，模型按需 read_selection
  assert.ok(!brief.includes('大量正文。大量正文'), '正文不该整篇塞进简报');
  assert.ok(!brief.includes(selText.slice(0, 10)), '选区全文不该进简报');
  assert.ok(brief.includes('read_selection'), '要提示可用工具读选区');
  assert.ok(brief.includes(String(selText.length)), '要报选区长度');
}

// ---------- describe()：给「每次审核」档看的落点与摘要 ----------
{
  const tab = fakeTab('main.tex', '第一行\nAAA\n第三行');
  const { executor } = makeDeps({ cmText: '活动文档', tabs: [tab], activeId: 'main.tex' });
  const e = executor.describe('edit_file', { path: 'main.tex', old_text: 'AAA', new_text: 'BBB' });
  assert.equal(e.mutates, true, 'edit_file 是改动手');
  assert.equal(e.path, 'main.tex', '落点用与工具同一套解析');
  assert.ok(e.detail.includes('AAA') && e.detail.includes('BBB'), '摘要带旧串与新串：' + e.detail);
  const ins = executor.describe('insert_text', { text: '插入的话' });
  assert.equal(ins.mutates, true);
  assert.equal(ins.path, 'main.tex', 'insert_text 落在活动文档');
  assert.ok(ins.detail.includes('插入的话'), '插入摘要带正文');
  const cf = executor.describe('create_file', { path: 'new/sec.tex', content: 'a'.repeat(50) });
  assert.equal(cf.mutates, true);
  assert.equal(cf.path, 'new/sec.tex');
  assert.ok(/50/.test(cf.detail), '建文件摘要带长度：' + cf.detail);
  assert.equal(executor.describe('read_file', { path: 'main.tex' }).mutates, false, '读类工具不需要审核');
  assert.equal(executor.describe('nope', {}).mutates, false, '未知工具不算改动手');
}

// ---------- 隐藏路径只在「完全访问」档放开 ----------
{
  const disk = { 'ch1.tex': '正文', '.env': 'SECRET=1' };
  const blocked = makeDeps({ disk });
  const r1 = await blocked.executor('read_file', { path: '.env' });
  assert.ok(!r1.ok, '默认档读不到隐藏文件');
  assert.equal(blocked.seen.diskReads.length, 0, '拒绝发生在打开句柄之前');
  const wide = makeDeps({ disk, approval: 'full' });
  const r2 = await wide.executor('read_file', { path: '.env' });
  assert.equal(r2.result, 'SECRET=1', '「完全访问」档由用户明确放弃这层保护');
  const ask = makeDeps({ disk, approval: 'ask' });
  assert.ok(!(await ask.executor('read_file', { path: '.env' })).ok, '「每次审核」也不放开隐藏文件');
}

console.log('agentTools: all tests passed');
