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
function fakeCm(text) {
  let value = text;
  return {
    getValue: () => value,
    setValue: v => { value = v; },
    getSelection: () => '',
    replaceSelection: v => { value += v; },
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
}

function fakeTab(path, text, id = path) {
  return { id, name: path, path, kind: 'tex', doc: fakeCm(text) };
}

function makeDeps({ cmText = '', tabs = [], folderIndex = {}, activeId = null, diagnostics = [] } = {}) {
  const cm = fakeCm(cmText);
  let edited = false;
  return {
    cm,
    edits: () => edited,
    executor: makeAgentExecutor({
      cm: () => cm,
      tabs: () => tabs,
      activeId: () => activeId || (tabs[0] && tabs[0].id),
      tabPath: tb => tb.path,
      folderIndex: () => folderIndex,
      rootDir: () => null,
      getDiagnostics: () => diagnostics,
      beforeEdit: () => { edited = true; },
      createFile: async () => ({ ok: true, msg: 'created' }),
      openByPath: async () => ({ ok: false, msg: 'not found' }),
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

// ---------- insert_text：光标插入（fake 里是追加）也要快照 ----------
{
  const { executor, edits } = makeDeps({ cmText: 'x' });
  const r = await executor('insert_text', { text: 'y' });
  assert.ok(r.ok && r.ok === true);
  assert.equal(edits(), true);
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

console.log('agentTools: all tests passed');
