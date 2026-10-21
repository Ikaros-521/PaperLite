/* TeX 词法的线性游标扫描件。
 *
 * 为什么单独成模块：\begin/\end 的配对扫描在渲染引擎（engines/latex.js matchEnvs）与
 * 静态检查（engines/linter.js envRe）里各写了一份，用的是同一条
 * /\\(begin|end)\s*\{([^}]+)\}/g。这条正则在「缺右括号」的输入上是二次方的：
 * 每个候选都把 [^}]+ 一路重扫到串尾，几千个 \begin{ 就把主线程锁死
 * （实测 82KB→0.36s、328KB→5.6s，每翻倍 4 倍；2MB 上限外推约 3.5 分钟）。
 * 同一份病态 .tex 会同时打挂预览与走查，所以游标只写一处。
 * 口径与 projectIndex.js 的 collectLabels 一致：一次 indexOf 定终身。
 */

// 与 engines/latex.js:148 的 skipWs 同一个 /\s/，不自己列空白字符：漏一个 \u2028
// 就等于让新旧两版对同一份文档给出不同的环境边界
const WS = /\s/;

/** 从 i 起跳过空白，返回第一个非空白下标（空白串互不相交，整体仍是线性） */
function skipSpace(s, i) {
  while (i < s.length && WS.test(s.charAt(i))) i++;
  return i;
}

/**
 * 线性枚举串中的 \begin{name} / \end{name} 词法单元。
 * cb 收到 { kind:'begin'|'end', name, start, end }：
 *   start = 反斜杠下标，end = 右花括号后一位
 * ——与旧正则的 m.index / m.index + m[0].length 逐位等价，偏移语义不能变
 * （渲染要按 start/end 切环境内外文，linter 要按 start 求行号）。
 *
 * 与旧正则的两点有意差异，都只在畸形文档上可见：
 *   1) 空环境名 \begin{} 不再算词法单元（旧正则的 [^}]* 允许空）——它本来就不是合法环境；
 *      需要沿用旧口径的调用方传 { emptyName: true }。
 *   2) 一旦确认「此后全无 }」，直接停止枚举：后续任何 \begin{ 都同样闭合不了，
 *      旧正则在这些位置也是零匹配，结论相同，只是不再花二次方的力气去证明。
 */
export function forEachEnv(s, cb, opts) {
  const allowEmpty = !!(opts && opts.emptyName);
  let p = 0;
  while (p < s.length) {
    const bAt = s.indexOf('\\begin', p);
    const eAt = s.indexOf('\\end', p);
    if (bAt < 0 && eAt < 0) return;
    let start, kind, wordLen;
    if (bAt < 0 || (eAt >= 0 && eAt < bAt)) { start = eAt; kind = 'end'; wordLen = 4; }
    else { start = bAt; kind = 'begin'; wordLen = 6; }
    const open = skipSpace(s, start + wordLen);
    if (s.charAt(open) !== '{') { p = start + 1; continue; }   // \beginning{x} 之类：不是环境名
    const close = s.indexOf('}', open + 1);
    if (close < 0) return;
    if (close === open + 1 && !allowEmpty) { p = start + 1; continue; }
    cb({ kind, name: s.slice(open + 1, close), start, end: close + 1 });
    p = close + 1;
  }
}
