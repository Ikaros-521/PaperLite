/* PaperLite · 英文拼写检查（纯函数，Node 可单测）
 *
 * 思路：先「等长遮罩」——把不该参与拼写的区域（注释 / 数学 / 逐字环境 / 命令名 /
 * 引用键等）换成空格（保留换行），再按行取词比对词典。
 * 遮罩等长，行列位置与源码一一对应，EditorPane 拿到结果可直接 markText。
 * 跨行的数学（$..$、$$..$$、\[..\]、\(..\)）与 verbatim/lstlisting/minted 环境有状态跟踪。
 */

// 花括号参数整段遮罩的命令。两组理由不同：
//   引用键 / 标签 / 路径不是自然语言（拼写与语法检查都不该碰）；
//   身份字段是隐私——语法检查/AI 校对开着时，正文会在停顿后自动发出去，
//   姓名/单位/邮箱不该顺带离开本机（尤其打开的是别人的稿子时）
const MASK_ARG_COMMANDS = new Set([
  'cite', 'citep', 'citet', 'citealp', 'citeauthor', 'citeyear', 'parencite', 'textcite',
  'ref', 'eqref', 'autoref', 'cref', 'crefrange', 'pageref', 'label',
  'includegraphics', 'bibliography', 'bibliographystyle', 'input', 'include', 'url',
  'author', 'affil', 'affiliation', 'email', 'thanks', 'orcid', 'address'
]);

const VERBATIM_ENVS = /^(verbatim\*?|lstlisting|minted)$/;

export function maskNonProse(srcRaw) {
  const s = String(srcRaw || '').replace(/\r\n?/g, '\n');
  const n = s.length;
  const out = s.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };

  // s[i] 处的 {..}（兼容嵌套与 \{ \}），返回 end+1 或 -1
  function groupEnd(i) {
    if (s.charAt(i) !== '{') return -1;
    let depth = 0;
    for (let k = i; k < n; k++) {
      const c = s.charAt(k);
      if (c === '\\') { k++; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return k + 1; }
    }
    return -1;
  }
  // s[i] 处的 [..]（内部 {} 中的 ] 不算）
  function optEnd(i) {
    if (s.charAt(i) !== '[') return -1;
    let depth = 0;
    for (let k = i; k < n; k++) {
      const c = s.charAt(k);
      if (c === '\\') { k++; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === ']' && depth <= 0) return k + 1;
    }
    return -1;
  }
  // \verb / \lstinline（可带 [选项]）：定界符不能是字母或 *；返回内容结束后的下标
  function verbEnd(i, cmdLen) {
    let p = i + cmdLen;
    if (s.slice(i + 1, i + 10) === 'lstinline' && s.charAt(p) === '[') {
      const oe = optEnd(p);
      if (oe > 0) p = oe;
    }
    const d = s.charAt(p);
    if (!d || /[A-Za-z*\\]/.test(d)) return -1;
    const close = d === '{' ? '}' : d === '[' ? ']' : d === '(' ? ')' : d;
    const eol = s.indexOf('\n', p + 1);
    const k = s.indexOf(close, p + 1);
    if (k < 0 || (eol >= 0 && k >= eol)) return -1;
    return k + 1;
  }

  let i = 0;
  let mathInline = false, mathDisplay = false, mathParen = false, mathBrack = false;
  while (i < n) {
    const c = s.charAt(i);
    if (c === '\n') { i++; continue; }

    // 四种数学态：只认各自结束定界符，其余字符一律遮掉
    if (mathDisplay) {
      if (s.substr(i, 2) === '$$') { blank(i, i + 2); mathDisplay = false; i += 2; continue; }
      out[i] = ' '; i++; continue;
    }
    if (mathInline) {
      if (c === '$') { out[i] = ' '; mathInline = false; i++; continue; }
      out[i] = ' '; i++; continue;
    }
    if (mathBrack) {
      if (s.substr(i, 2) === '\\]') { blank(i, i + 2); mathBrack = false; i += 2; continue; }
      out[i] = ' '; i++; continue;
    }
    if (mathParen) {
      if (s.substr(i, 2) === '\\)') { blank(i, i + 2); mathParen = false; i += 2; continue; }
      out[i] = ' '; i++; continue;
    }

    // 行内注释：% 前是偶数个连续反斜杠才算注释（与 texComments 同口径）。
    // 扫描器成对消费反斜杠，`\%` 早就被当转义吞掉了；还带着反斜杠前缀落到这里的
    // 正是 `\\%`（换行命令 + 真注释），旧写法把它当字面百分号，注释里的单词全进词典。
    if (c === '%') {
      let b = i - 1, bs = 0;
      while (b >= 0 && s.charAt(b) === '\\') { bs++; b--; }
      if (bs % 2 === 0) {
        let e = s.indexOf('\n', i);
        if (e < 0) e = n;
        blank(i, e); i = e; continue;
      }
    }

    if (c === '$') {
      if (s.substr(i, 2) === '$$') { blank(i, i + 2); mathDisplay = true; i += 2; continue; }
      out[i] = ' '; mathInline = true; i++; continue;
    }

    if (c === '\\') {
      const two = s.substr(i, 2);
      if (two === '\\[') { blank(i, i + 2); mathBrack = true; i += 2; continue; }
      if (two === '\\(') { blank(i, i + 2); mathParen = true; i += 2; continue; }
      const m = s.slice(i).match(/^\\([A-Za-z]+)\*?/);
      if (m) {
        const cmd = m[1];
        blank(i, i + m[0].length);
        let p = i + m[0].length;
        if (cmd === 'verb' || cmd === 'lstinline') {
          const ve = verbEnd(i, m[0].length);
          if (ve > 0) { blank(p, ve); i = ve; continue; }
          i = p; continue;
        }
        if (cmd === 'begin' || cmd === 'end') {
          const ge = groupEnd(p);
          const envName = ge > 0 ? s.slice(p + 1, ge - 1) : '';
          if (ge > 0) blank(p, ge);
          if (cmd === 'begin' && VERBATIM_ENVS.test(envName)) {
            const endStr = '\\end{' + envName + '}';
            const stop = s.indexOf(endStr, ge > 0 ? ge : p);
            blank(ge > 0 ? ge : p, stop < 0 ? n : stop);
            i = ge > 0 ? ge : p; continue;
          }
          i = ge > 0 ? ge : p; continue;
        }
        if (MASK_ARG_COMMANDS.has(cmd)) {
          let q = p;
          const oe = optEnd(q);
          if (oe > 0) q = oe;
          const ge = groupEnd(q);
          if (ge > 0) { blank(q, ge); i = ge; continue; }
          i = p; continue;
        }
        if (cmd === 'href') { // 只遮 URL 参数，链接文字仍参与拼写
          const ge = groupEnd(p);
          if (ge > 0) { blank(p, ge); i = ge; continue; }
          i = p; continue;
        }
        i = p; continue;
      }
      blank(i, Math.min(n, i + 2)); i += 2; continue;  // \\ \% \{ 等转义
    }
    i++;
  }
  return out.join('');
}

// 词典文本 + 用户词（数组）→ 判词函数；做常见屈折还原，不把派生词全塞进词典
export function buildChecker(dictText, extraWords) {
  const dict = new Set();
  const push = w => { const lw = String(w || '').trim().toLowerCase(); if (lw) dict.add(lw); };
  String(dictText || '').split('\n').forEach(push);
  (extraWords || []).forEach(push);

  const ONES = new Set(['a', 'i']);
  function known(w) {
    if (!w) return true;
    if (ONES.has(w)) return true;
    if (dict.has(w)) return true;
    if (w.length <= 1) return true;
    // 缩写：n't / 'll / 've / 're / 'd / 'm 是粘在后缀上的助动词，词干才是真词
    if (w.endsWith("n't") || w.endsWith('n’t')) return known(w.slice(0, -3));
    if (w.endsWith("'ll") || w.endsWith('’ll') || w.endsWith("'ve") || w.endsWith('’ve') || w.endsWith("'re") || w.endsWith('’re')) return known(w.slice(0, -3));
    if (w.endsWith("'d") || w.endsWith('’d') || w.endsWith("'m") || w.endsWith('’m')) return known(w.slice(0, -2));
    if (w.endsWith("'s") || w.endsWith('’s')) return known(w.slice(0, -2));
    if (w.includes('-') || w.includes('_')) return w.split(/[-_]/).every(p => p.length < 2 || known(p));
    const tries = [];
    if (w.endsWith('ies') && w.length > 4) tries.push(w.slice(0, -3) + 'y');
    if (w.endsWith('es') && w.length > 3) tries.push(w.slice(0, -2));
    if (w.endsWith('s') && w.length > 3) tries.push(w.slice(0, -1));
    if (w.endsWith('ed') && w.length > 3) {
      tries.push(w.slice(0, -2));
      if (w.length > 4 && /[bcdfghjklmnpqrstvwxz]{2}$/.test(w.slice(0, -2))) tries.push(w.slice(0, -3));
    }
    if (w.endsWith('ing') && w.length > 4) {
      tries.push(w.slice(0, -3));
      if (w.length > 5 && /[bcdfghjklmnpqrstvwxz]{2}$/.test(w.slice(0, -3))) tries.push(w.slice(0, -4));
    }
    return tries.some(t => dict.has(t));
  }
  return function isWord(raw) {
    const w = String(raw || '');
    // 缩写/首字母：USA、PhD 里的全大写段，放宽处理
    if (/^[A-Z][A-Z0-9]*$/.test(w)) return true;
    const lw = w.toLowerCase();
    if (known(lw)) return true;
    // 缩写分写（don't、O'Brien）与弯撇号
    if (/['’]/.test(lw)) return lw.split(/['’]/).every(p => p.length < 2 || known(p));
    return false;
  };
}

// 返回 [{line, from, to, word}]（0 起行列），word 为原文切片（遮罩不改写字母本身）
export function findTypos(src, isWord) {
  const masked = maskNonProse(src);
  const typos = [];
  const lines = masked.split('\n');
  const re = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
  for (let li = 0; li < lines.length; li++) {
    const text = lines[li];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      const w = m[0];
      if (!isWord(w)) typos.push({ line: li, from: m.index, to: m.index + w.length, word: w });
    }
  }
  return typos;
}
