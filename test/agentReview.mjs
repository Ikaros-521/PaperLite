/**
 * 验收评审：证据装配、结论 JSON 解析、独立一次请求的装配口径。
 * 评审与执行解耦是这套设计的最后一环——它测的正是「喂给评审的只有证据，没有执行者的思路」。
 */
import assert from 'node:assert/strict';
import { reviewEvidence, parseVerdict, runReview } from '../src/workspace/agentReview.js';
import { createTask, setPlan, updateStep, noteChange, recordAudit } from '../src/workspace/agentTask.js';
import { setLang } from '../src/i18n.js';

setLang('zh');

const task = () => {
  const t = createTask({ goal: '把方法节写清楚并修完语法' });
  setPlan(t, { goal: 'g', steps: [
    { title: '读方法节', deliverable: 'main.tex 方法节正文', done_when: '读到内容' },
    { title: '重写', deliverable: '替换文本', done_when: 'edit_file 成功', deps: [1] },
    { title: '复查', deliverable: '诊断清单', done_when: '0 条问题', deps: [2] },
  ] });
  updateStep(t, { step: 1, status: 'doing' });
  noteChange(t, 'main.tex', 'v1');
  updateStep(t, { step: 1, status: 'done' });
  updateStep(t, { step: 2, status: 'doing' });
  recordAudit(t, { step: 1, tool: 'edit_file', args: '{}', ok: false, code: 'old_ambiguous', chars: 0 });
  t.counters.calls = 9; t.counters.writes = 2; t.counters.blocked = 1; t.counters.cacheHits = 3;
  return t;
};

/* ---------- 证据装配 ---------- */
{
  const ev = reviewEvidence(task(), '方法节已重写，诊断剩 0 条。');
  assert.ok(ev.includes('把方法节写清楚并修完语法'), '原始目标要在证据里');
  assert.ok(ev.includes('重写') && ev.includes('edit_file 成功'), '子任务与完成判定');
  assert.ok(ev.includes('[done]') && ev.includes('[doing]'), '每步状态如实给出');
  assert.ok(ev.includes('9') && ev.includes('拦截'), '框架统计的计数');
  assert.ok(ev.includes('edit_file(old_ambiguous)'), '失败的调用要列出来');
  assert.ok(ev.includes('main.tex'), '改动过的文件');
  assert.ok(ev.includes('方法节已重写'), '最终回答');
  const long = reviewEvidence(task(), 'x'.repeat(9000));
  assert.ok(long.length < 8000, '回答再长也要截断：' + long.length);
  const clean = createTask({ goal: '看看项目结构' });
  setPlan(clean, { goal: 'g', steps: [{ title: '列文件', deliverable: '清单', done_when: 'list_files 成功' }] });
  const ev2 = reviewEvidence(clean, '结构如下');
  assert.ok(ev2.includes('没有失败的调用'), '没失败就照实说没失败');
  assert.ok(ev2.includes('本轮没有改动任何文件'), '没改文件就照实说没改');
}

/* ---------- parseVerdict ---------- */
{
  const ok = parseVerdict('结论：\n{"goal_ok":true,"missing":[],"process_ok":true,"process_issues":[],"quality_ok":true,"quality_issues":[]}');
  assert.ok(ok && ok.goalOk && ok.processOk && ok.qualityOk);

  // 结论后面还跟着 LaTeX 正文（花括号不成对）：不能被最后一个花括号带偏
  const messy = parseVerdict('前文\n{"goal_ok":false,"missing":["实验章节没复查"],"process_ok":true,"process_issues":[],"quality_ok":false,"quality_issues":["结论无出处"]}\n补充：公式 x^{2} 也需要处理');
  assert.ok(messy, '尾部有花括号也要取出结论');
  assert.equal(messy.goalOk, false);
  assert.deepEqual(messy.missing, ['实验章节没复查']);
  assert.deepEqual(messy.qualityIssues, ['结论无出处']);

  // 嵌套结构不影响取顶层对象
  const nested = parseVerdict('{"goal_ok":true,"missing":[],"process_ok":false,"process_issues":["改到 a.tex 之外"],"quality_ok":true,"quality_issues":[]}');
  assert.equal(nested.processOk, false);

  assert.equal(parseVerdict('我觉得做得挺好，没有问题。'), null, '没给 JSON 就是没结论');
  assert.equal(parseVerdict('{"foo":1}'), null, '不是结论形状的 JSON 不算结论');
  assert.equal(parseVerdict(''), null);
  // 数组超长截断：评审灌 40 条问题时面板不能被撑爆
  const many = parseVerdict('{"goal_ok":false,"missing":[' + Array.from({ length: 30 }, (_, i) => '"m' + i + '"').join(',') + ']}');
  assert.equal(many.missing.length, 8, '每类问题最多留 8 条');
}

/* ---------- 一次独立请求 ---------- */
{
  const channel = { protocol: 'openai', baseUrl: "http://127.0.0.1:8788/v1", chatModel: 'mock-model', apiKey: '' };
  let body = null;
  globalThis.fetch = async (u, opts) => {
    body = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({
        choices: [{ message: { content: '核对后：\n{"goal_ok":true,"missing":[],"process_ok":true,"process_issues":[],"quality_ok":true,"quality_issues":[]}' } }],
        usage: { prompt_tokens: 900, completion_tokens: 60 },
      }),
    };
  };
  const r = await runReview({ channel, task: task(), finalAnswer: '做完了', signal: null });
  globalThis.fetch = undefined;
  assert.equal(body.stream, false, '评审不流式：只要一份可解析的结论');
  assert.ok(body.messages[0].role === 'system' && body.messages[0].content.includes('评审'), '系统提示词表明它是评审而不是执行者');
  assert.ok(body.messages[0].content.includes('goal_ok'), '提示词要写清三项校验与输出格式');
  assert.ok(body.messages.some(m => m.content.includes('原始目标')), '证据进载荷');
  assert.ok(!body.messages.some(m => m.content.includes('v1')), '版本 id 这类内部细节不给评审');
  assert.ok(r.verdict && r.verdict.goalOk, '结论被解析出来');
  assert.equal(r.usage.input, 900);
  assert.equal(r.usage.output, 60);
  assert.ok(r.text.includes('核对后'), '原文留着给人看');
}

console.log('agentReview: all tests passed');
