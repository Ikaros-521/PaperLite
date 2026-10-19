/* 主文档（编译入口）解析测试：固定设置、自动探测、磁盘扫描回退 */
import { hasDocumentclass, resolveMainDoc, loadMainDocSetting, saveMainDocSetting, renameMainDocEntry } from '../src/mainDoc.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

console.log('== hasDocumentclass ==');
ok(hasDocumentclass('\\documentclass{article}\n\\begin{document}x\\end{document}'), '正常主文档');
ok(!hasDocumentclass('% \\documentclass{article}\n\\section{仅注释}'), '被注释掉的导言区不算');
ok(!hasDocumentclass('\\input{main}\n\\section{子文件}'), '子文件无 documentclass');
ok(hasDocumentclass('100\\% \\documentclass{article}'), '转义 % 后的 documentclass 仍可探测');

console.log('== resolveMainDoc ==');
const doc = (t) => ({ source: t });

// 1. 固定设置优先
let r = resolveMainDoc({
  pinned: 'paper/main.tex',
  activePath: 'paper/ch1.tex',
  candidates: [
    { path: 'paper/ch1.tex', name: 'ch1.tex', source: '\\section{one}', open: true },
    { path: 'paper/main.tex', name: 'main.tex', source: '\\documentclass{article}', open: false, isMain: true },
  ],
});
ok(r && r.path === 'paper/main.tex' && r.via === 'pinned', '固定设置命中');

// 2. 固定的文件不存在 → 退回自动
r = resolveMainDoc({
  pinned: 'gone.tex',
  activePath: 'a.tex',
  candidates: [{ path: 'a.tex', name: 'a.tex', source: '\\documentclass{article}', open: true }],
});
ok(r && r.path === 'a.tex' && r.via === 'active', '固定失效退回当前标签（本身是主文档）');

// 3. 当前标签是主文档 → active
r = resolveMainDoc({ pinned: null, activePath: 'm.tex', candidates: [{ path: 'm.tex', name: 'm.tex', source: '\\documentclass{ctexart}', open: true }, { path: 'ch.tex', name: 'ch.tex', source: '\\section', open: true }] });
ok(r && r.via === 'active', '当前标签即主文档');

// 4. 当前是子文件 + 打开的主文档标签 → open-guess
r = resolveMainDoc({
  pinned: null,
  activePath: 'ch1.tex',
  candidates: [
    { path: 'ch1.tex', name: 'ch1.tex', source: '\\section{sub}', open: true },
    { path: 'thesis.tex', name: 'thesis.tex', source: '\\documentclass{article}', open: true },
  ],
});
ok(r && r.path === 'thesis.tex' && r.via === 'open-guess', '探测打开标签里的主文档');

// 5. main.tex 命名优先于其他打开的主文档
r = resolveMainDoc({
  pinned: null,
  activePath: 'ch1.tex',
  candidates: [
    { path: 'ch1.tex', name: 'ch1.tex', source: '\\section{sub}', open: true },
    { path: 'other.tex', name: 'other.tex', source: '\\documentclass{article}', open: true },
    { path: 'main.tex', name: 'main.tex', source: '\\documentclass{article}', open: true },
  ],
});
ok(r && r.path === 'main.tex', 'main.tex 命名优先');

// 6. 没有打开的主文档 → 磁盘扫描
r = resolveMainDoc({
  pinned: null,
  activePath: 'ch1.tex',
  candidates: [
    { path: 'ch1.tex', name: 'ch1.tex', source: '\\section{sub}', open: true },
    { path: 'main.tex', name: 'main.tex', source: '\\documentclass{article}', open: false, isMain: true },
  ],
});
ok(r && r.path === 'main.tex' && r.via === 'scan' && r.open === false, '磁盘扫描回退，source 来自磁盘');

// 7. 完全没有 documentclass → 保持旧行为（编译当前标签）
r = resolveMainDoc({ pinned: null, activePath: 'ch1.tex', candidates: [{ path: 'ch1.tex', name: 'ch1.tex', source: '\\section{sub}', open: true }] });
ok(r && r.via === 'active-fallback', '无主文档时退回当前标签');

// 8. 空候选 → null
ok(resolveMainDoc({ pinned: null, activePath: 'x', candidates: [] }) === null, '空候选返回 null');

// 9. 打开的主文档内容应是编辑中的内容（未保存修改参与编译）
r = resolveMainDoc({
  pinned: 'main.tex',
  activePath: 'ch1.tex',
  candidates: [
    { path: 'ch1.tex', name: 'ch1.tex', source: '\\section{sub}', open: true },
    { path: 'main.tex', name: 'main.tex', source: '\\documentclass{article}%editing', open: true },
  ],
});
ok(r && r.source.includes('%editing'), '固定命中打开标签时取实时内容');

console.log('== pin 改名迁移 ==');
const lsStore = new Map();
globalThis.localStorage = { getItem: k => (lsStore.has(k) ? lsStore.get(k) : null), setItem: (k, v) => lsStore.set(k, v) };
saveMainDocSetting('paper', 'chapters/intro.tex');
saveMainDocSetting('other', 'main.tex');
ok(renameMainDocEntry('chapters/intro.tex', 'chapters/intro-v2.tex') === true, '文件改名要迁移 pin');
ok(loadMainDocSetting().paper === 'chapters/intro-v2.tex', 'pin 跟着改名走: ' + loadMainDocSetting().paper);
ok(loadMainDocSetting().other === 'main.tex', '别的文件夹不受影响');
ok(renameMainDocEntry('chapters', 'secs') === true, '文件夹改名换整段前缀');
ok(loadMainDocSetting().paper === 'secs/intro-v2.tex', '前缀迁移: ' + loadMainDocSetting().paper);
ok(renameMainDocEntry('secs', 'secs') === false && renameMainDocEntry('', 'x') === false, '同名或空路径不动存储');
ok(renameMainDocEntry('gone', 'x') === false, '没命中就别惊动 React 状态');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
