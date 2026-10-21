/* 跨文件 \ref / \cite 索引：label 收集、bib key 解析、注释处理、补全上下文 */
import { collectLabels, collectBibKeys, matchRefContext } from '../src/projectIndex.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

console.log('== 项目索引：label ==');

const tex = `\\documentclass{article}
\\begin{document}
\\section{Intro}\\label{sec:intro}
Text.
\\begin{equation}\\label{eq:main}
  a=b
\\end{equation}
\\label{ sec:spaced } % 尾随注释
\\end{document}`;
const labels = collectLabels(tex);
ok(labels.length === 3, '收集到 3 个 label, got ' + labels.length);
ok(labels[0].key === 'sec:intro', 'label 1: ' + labels[0].key);
ok(labels[1].key === 'eq:main', 'label 2: ' + labels[1].key);
ok(labels[2].key === 'sec:spaced', 'trim 空白: ' + labels[2].key);

// 注释里的 \label 不算
const commented = 'real\\label{a}\n% fake\\label{ghost}\ntext\\label{b} % tail\\label{tail}';
ok(collectLabels(commented).map(l => l.key).join(',') === 'a,b', '注释中的 label 忽略: ' + collectLabels(commented).map(l => l.key).join(','));

// 转义的 \% 不是注释
const escaped = 'lab\\label{x} \\% not comment\\label{y}';
ok(collectLabels(escaped).length === 2, '\\% 转义不当注释: ' + collectLabels(escaped).length);

// 偶数个反斜杠（\\% 是换行命令 + 真注释）——与 lint/预览同一套奇偶口径
const lineBreakComment = 'row1\\\\% \\label{ghost}\n\\label{real}';
ok(collectLabels(lineBreakComment).map(l => l.key).join(',') === 'real',
  '\\\\% 之后算注释: ' + collectLabels(lineBreakComment).map(l => l.key).join(','));

// 等长抹除：pos 是按源码偏移算的，删字符会让跳转落到别的行
const posSrc = '\\label{a}\n% long trailing comment here\n\\label{b}';
const posLabels = collectLabels(posSrc);
ok(posLabels.length === 2 && posSrc.slice(posLabels[1].pos, posLabels[1].pos + 9) === '\\label{b}',
  'pos 仍指向原文偏移: ' + JSON.stringify(posLabels.map(l => l.pos)));

// 空 label 不要
ok(collectLabels('\\label{} \\label{ok}').length === 1, '空 label 跳过');

// 多文档：键可以重复出现在不同文件（索引层不去重，UI 层再合并）
const two = ['\\label{dup}\\label{one}', '\\label{dup}\\label{two}'];
ok(collectLabels(two[0]).length + collectLabels(two[1]).length === 4, '跨文件分别收集');

console.log('== 项目索引：bib key ==');

const bib = `@article{vaswani2017attention,
  title={Attention Is All You Need},
  author={Vaswani, Ashish},
}
@inproceedings{he2016deep,
  title={Deep Residual Learning},
}
@misc{ noSpaces ,
  howpublished={\\url{https://example.com}},
}`;
const keys = collectBibKeys(bib);
ok(keys.length === 3, '3 个条目, got ' + keys.length);
ok(keys[0].key === 'vaswani2017attention', 'key 1: ' + keys[0].key);
ok(keys[1].key === 'he2016deep', 'key 2: ' + keys[1].key);
ok(keys[2].key === 'noSpaces', '空白 key trim: ' + keys[2].key);

// 注释掉的条目不算
const bibCommented = '@book{real, title={T}}\n% @book{ghost, title={G}}\n@book{alsoReal}';
ok(collectBibKeys(bibCommented).map(k => k.key).join(',') === 'real,alsoReal', '注释条目忽略');

console.log('== 项目索引：补全上下文 ==');

let c = matchRefContext('text \\ref{sec');
ok(c && c.cmd === 'ref' && c.isCite === false && c.segment === 'sec', '\\ref{sec → ref/sec: ' + JSON.stringify(c));

c = matchRefContext('\\eqref{eq:ma');
ok(c && c.cmd === 'eqref' && c.segment === 'eq:ma' && c.isCite === false, '\\eqref 走 labels');

c = matchRefContext('\\cite{vasw,he');
ok(c && c.isCite === true && c.segment === 'he', '逗号后取当前片段（不吞已键入的键）: ' + JSON.stringify(c));

c = matchRefContext('\\citep[see][p.~2]{key');
ok(c && c.cmd === 'citep' && c.segment === 'key', '可选参数跳过: ' + JSON.stringify(c));

c = matchRefContext('\\Cref{fig:');
ok(c && c.cmd === 'Cref' && c.isCite === false, '\\Cref 走 labels（大小写敏感不撞 cite）');

c = matchRefContext('\\ref*{sec:app');
ok(c && c.cmd === 'ref' && c.segment === 'sec:app', '星号变体');

c = matchRefContext('\\label{sec:a');
ok(c === null, '\\label 不触发补全');

c = matchRefContext('\\section{intro');
ok(c === null, '\\section 不触发补全');

c = matchRefContext('plain text without command');
ok(c === null, '普通文本不触发');

c = matchRefContext('\\cite{one, two');
ok(c && c.segment === ' two', '逗号后含空白的片段如实返回（由 hint 过滤）：' + JSON.stringify(c.segment));

// \label{ 没有 } 时，正则版会从每个起点把 [^}]+ 重试到文末（360KB 实测 4.66s，
// 而补全每敲一下都对所有打开标签跑一遍）；游标版必须留在毫秒级
{
  const bad = '\\label{ '.repeat(80000);   // ≈1.44MB，旧写法外推上百秒
  const t0 = Date.now();
  const res = collectLabels(bad);
  const ms = Date.now() - t0;
  ok(ms < 800, '无右界的批量 \\label{ 保持线性, got ' + ms + 'ms');
  ok(res.length === 0, '一个都闭不上时不该产出键');
  const mixed = collectLabels('\\label{a} ' + '\\label{ '.repeat(20000));
  ok(mixed.length === 1 && mixed[0].key === 'a', '前面合法的 label 仍收到（游标不被后面的坏数据带偏）');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
