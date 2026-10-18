/* AI 用词检测纯逻辑测试：提示词构造、JSON 容错解析、quote 回定位与幻觉丢弃 */
import { buildProofMessages, extractJSON, parseAIResult, proofChunks, AI_CHUNK_MAX, AI_MAX_ITEMS } from '../src/aiProofread.js';
import { maskNonProse } from '../src/spellcheck.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

console.log('== extractJSON：围栏/噪声容错 ==');
ok(JSON.stringify(extractJSON('[{"a":1}]')) === '[{"a":1}]', '裸数组');
ok(JSON.stringify(extractJSON('```json\n[{"a":1}]\n```')) === '[{"a":1}]', 'markdown 围栏');
ok(JSON.stringify(extractJSON('好的，结果如下：\n[{"q":"x"}] 以上。')) === '[{"q":"x"}]', '前后杂文');
ok(extractJSON('') === null, '空输入');
ok(extractJSON('没有任何数组') === null, '无数组');
ok(extractJSON('[broken json') === null, '坏 JSON 返回 null');

console.log('== buildProofMessages ==');
const msgs = buildProofMessages('This documentation illustrates.');
ok(msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user', 'system+user 两条');
ok(msgs[1].content.includes('This documentation illustrates.'), '正文进入 user 消息');
ok(msgs[1].content.includes('quote'), '提示词钉死 quote 逐字引用');
ok(msgs[0].content.length > 20, 'system 提示词非空');

console.log('== parseAIResult：用户场景 documentation→document ==');
const src = 'This documentation illustrates the usage of the parser.';
const masked = maskNonProse(src);
const out = parseAIResult(JSON.stringify([
  { quote: 'documentation', message: '指单个文档应用 document；documentation 通常指文档集合。', suggestions: ['document'] },
]), masked, 0);
ok(out.length === 1, '命中一条');
ok(out[0].line === 0 && out[0].from === src.indexOf('documentation') && out[0].to === src.indexOf('documentation') + 13, '区间映射回 documentation 原位');
ok(out[0].replacements[0] === 'document', '替换建议保留');
ok(out[0].msg.includes('document'), '消息透传');

console.log('== 幻觉与边界丢弃 ==');
const src2 = '第一行正文内容。\n\\label{sec:x}\n第三行 he have an error.';
const m2 = maskNonProse(src2);
const o2 = parseAIResult(JSON.stringify([
  { quote: '原文中根本不存在的片段', message: '幻觉', suggestions: [] },            // 幻觉：找不到 → 丢弃
  { quote: 'd', message: '过短', suggestions: [] },                                  // <2 字符 → 丢弃
  { quote: 'x'.repeat(81), message: '过长', suggestions: [] },                       // >80 字符 → 丢弃
  { quote: '正文内容', message: '正常一条', suggestions: ['内容正文', '文本内容'] },   // 应接受
  { quote: '正文内容', message: '与前一条重叠', suggestions: [] },                   // 区间重叠 → 丢弃
  { quote: 'he have', message: '' , suggestions: ['he has'] },                       // 无 message → 丢弃
  { quote: '  he have  ', message: '主谓一致', suggestions: ['he has', 'he had', 'he has had', 'x'] }, // 首尾空格 trim 后应接受
]), m2, 0);
ok(o2.length === 2, '只接受两条（幻觉/过短/过长/重叠/空消息全丢弃）：' + o2.length);
const l0 = m2.split('\n')[0];
ok(l0.slice(o2[0].from, o2[0].to) === '正文内容', '第 0 行映射回「正文内容」');
ok(o2[0].replacements.length === 2, '建议截断至 3 以内：' + o2[0].replacements.length);
ok(o2[1].replacements.length === 3, '第 4 条建议被截掉');
const l2 = m2.split('\n')[2];
ok(l2.slice(o2[1].from, o2[1].to) === 'he have', 'trim 后定位「he have」');

console.log('== 块偏移与条数上限 ==');
const long = ('段落甲乙丙丁。'.repeat(4) + '\n\n').repeat(3);
const m3 = maskNonProse(long);
const chunks3 = proofChunks(m3);
ok(chunks3.length === 1 && chunks3[0].text.length === m3.length, '未超 AI_CHUNK_MAX 单块整体送检');
const long2 = ('单词 word '.repeat(2500) + '\n\n').repeat(3);   // 约 15000 字符 → 2 块
const chunks4 = proofChunks(maskNonProse(long2));
ok(chunks4.length >= 2 && chunks4[0].text.length <= AI_CHUNK_MAX, '超限分块且单块不超上限');
const second = chunks4[1];
const o4 = parseAIResult(JSON.stringify([{ quote: 'word', message: '测试块偏移', suggestions: [] }]), maskNonProse(long2), second.offset);
ok(o4.length === 1 && o4[0].line >= 0, '第二块的 quote 经 chunkOffset 正确回定位');
// 用互不重叠的多个词验证 AI_MAX_ITEMS 上限
const words = [];
for (let i = 0; i < AI_MAX_ITEMS + 3; i++) words.push('word' + i);
const src5 = words.join(' ') + '\n' + 'word tail';
const m5 = maskNonProse(src5);
const o5 = parseAIResult(JSON.stringify(words.map(w => ({ quote: w, message: 'm', suggestions: [] }))), m5, 0);
ok(o5.length === AI_MAX_ITEMS, '超过 AI_MAX_ITEMS 截断：' + o5.length);

console.log('== 非数组和空结果 ==');
ok(parseAIResult('模型坏掉了', m5, 0).length === 0, '非 JSON → 空');
ok(parseAIResult('[]', m5, 0).length === 0, '空数组 → 空');
ok(parseAIResult('[{"quote":"word0","message":"m"}]', m5, 0).length === 1, '缺 suggestions 字段容忍');

console.log('== 新增文案双语完整 ==');
import { DICT } from '../src/i18n.js';
for (const key of ['file.aiProofread', 'file.aiProofreadHint', 'gm.aiTag', 'ai.proofSystem', 'ai.proofUser']) {
  ok(typeof DICT.en[key] === 'string' && DICT.en[key].length > 0, '英文文案存在: ' + key);
  ok(!/[\u4e00-\u9fff]/.test(DICT.en[key]), '英文无汉字: ' + key);
  ok(typeof DICT.zh[key] === 'string' && DICT.zh[key].length > 0, '中文文案存在: ' + key);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
