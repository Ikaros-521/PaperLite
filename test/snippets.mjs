/* 自定义片段纯逻辑测试：存储往返（注入假 storage）、坏数据容错、名称校验 */
import { loadSnippets, saveSnippets, validateSnippetName, nextSnippetId } from '../src/snippets.js';
import { DICT } from '../src/i18n.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

// 假 storage：Map 语义，够测往返与坏数据
const fake = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, _m: m };
};

console.log('== 存储往返 ==');
let st = fake();
ok(loadSnippets(st).length === 0, '空存储返回空数组');
ok(saveSnippets([{ id: 'a1', name: '定理', content: '\\begin{theorem}\n\n\\end{theorem}' }], st) === true, '保存成功');
let list = loadSnippets(st);
ok(list.length === 1 && list[0].name === '定理' && list[0].content.includes('theorem'), '读回完整');
ok(saveSnippets(list, st) === true && loadSnippets(st).length === 1, '幂等保存');

console.log('== 坏数据容错 ==');
st = fake(); st.setItem('paperlite.snippets.v1', '{broken json');
ok(loadSnippets(st).length === 0, '坏 JSON 返回空');
st.setItem('paperlite.snippets.v1', '{"not":"array"}');
ok(loadSnippets(st).length === 0, '非数组返回空');
st.setItem('paperlite.snippets.v1', JSON.stringify([{ id: 1, name: 'ok', content: 'x' }, { name: 42, content: 'y' }, null]));
list = loadSnippets(st);
ok(list.length === 1 && list[0].id === '1', '过滤非法条目并字符串化 id：' + JSON.stringify(list.map(x => x.id)));
ok(saveSnippets('not-a-list', st) === true && loadSnippets(st).length === 0, '非数组入参清空保存');
ok(saveSnippets(null) === false || true, '无存储时不抛异常');

console.log('== 名称校验 ==');
const existing = [{ id: 'x1', name: '定理' }, { id: 'x2', name: '算法' }];
let v = validateSnippetName('  新定理 ', existing);
ok(v.ok === true && v.name === '新定理', '去首尾空白');
ok(validateSnippetName('', existing).error === 'empty', '空名拒绝');
ok(validateSnippetName('   ', existing).error === 'empty', '纯空白拒绝');
ok(validateSnippetName('定理', existing).error === 'duplicate', '重名拒绝');
ok(validateSnippetName('定理', existing, 'x1').ok === true, '编辑自己时同名放行');
ok(validateSnippetName('新片段', existing).ok === true, '新名放行');

console.log('== id 生成 ==');
const id1 = nextSnippetId(), id2 = nextSnippetId();
ok(id1 !== id2 && /^sn[0-9a-z]+$/.test(id1), 'id 唯一且格式稳定');

console.log('== 新增文案双语完整 ==');
for (const key of ['m.typewriter', 'm.zen', 'm.mySnippets', 'm.manageSnippets', 'm.snippets', 'sn.note', 'sn.add', 'sn.edit', 'sn.del', 'sn.delConfirm', 'sn.cancel', 'sn.save', 'sn.name', 'sn.content', 'sn.empty', 'sn.nameEmpty', 'sn.nameDup']) {
  ok(typeof DICT.en[key] === 'string' && DICT.en[key].length > 0, '英文文案存在: ' + key);
  ok(!/[\u4e00-\u9fff]/.test(DICT.en[key]), '英文无汉字: ' + key);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
