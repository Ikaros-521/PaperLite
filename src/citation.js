/* PaperLite · 文献检索插入（纯逻辑，Node 可单测）
 *
 * 浏览器直连公共学术检索 API（都允许 CORS，不经任何服务器中转）：
 *   Crossref  https://api.crossref.org/works        期刊论文 / DOI 事实标准
 *   OpenAlex  https://api.openalex.org/works        全学科开放索引
 *   DBLP      https://dblp.org/search/publ/api      计算机科学文献库
 * 这里只做三件事：构造检索 URL、把各家响应归一化成统一条目、把条目变成 BibTeX。
 * 网络请求（fetch / 超时 / 取消）在 CiteDialog 组件里，便于注入与降级。
 */

export const PROVIDERS = {
  crossref: {
    url: q => 'https://api.crossref.org/works?rows=12&select=DOI,title,author,issued,container-title,type,volume,issue,page,URL&query=' + encodeURIComponent(q),
    parse: parseCrossref,
  },
  openalex: {
    // mailto 进 polite pool，公共接口限流更宽
    url: q => 'https://api.openalex.org/works?per-page=12&mailto=paperlite-users@example.org&search=' + encodeURIComponent(q),
    parse: parseOpenAlex,
  },
  dblp: {
    url: q => 'https://dblp.org/search/publ/api?h=12&format=json&q=' + encodeURIComponent(q),
    parse: parseDblp,
  },
};
// 解析器一并导出：单测直接喂 fixture JSON，不碰网络
export { parseCrossref, parseOpenAlex, parseDblp };

/** 全名 "San Zhang" → "Zhang, San"（BibTeX 习惯 family 在前）；单名原样返回 */
export function familyFirst(fullName) {
  const s = String(fullName || '').trim();
  if (!s || s.includes(',')) return s;
  const parts = s.split(/\s+/);
  if (parts.length < 2) return s;
  return parts[parts.length - 1] + ', ' + parts.slice(0, -1).join(' ');
}

// ---- 各家响应 → [{title, authors[], year, venue, type, volume, issue, pages, doi, url, source}] ----

function entryTypeOf(raw, map) {
  const t = String(raw || '').toLowerCase();
  for (const re of map) if (re[0].test(t)) return re[1];
  return 'misc';
}

function parseCrossref(json) {
  const items = (json && json.message && Array.isArray(json.message.items)) ? json.message.items : [];
  return items.map(it => {
    const authors = (it.author || []).map(a => [a.family, a.given].filter(Boolean).join(', ')).filter(Boolean);
    return {
      title: (it.title || [])[0] || '',
      authors,
      year: (it.issued && it.issued['date-parts'] || [])[0] && it.issued['date-parts'][0][0] || null,
      venue: (it['container-title'] || [])[0] || '',
      type: entryTypeOf(it.type, [[/journal-article/, 'article'], [/proceedings-article|paper-conference/, 'inproceedings']]),
      volume: it.volume || '', issue: it.issue || '', pages: it.page || '',
      doi: it.DOI || '', url: it.URL || '',
      source: 'Crossref',
    };
  }).filter(e => e.title);
}

function parseOpenAlex(json) {
  const items = (json && Array.isArray(json.results)) ? json.results : [];
  return items.map(it => {
    const authors = (it.authorships || []).map(a => a.author && a.author.display_name).filter(Boolean).map(familyFirst);
    return {
      title: it.display_name || '',
      authors,
      year: it.publication_year || null,
      venue: (it.primary_location && it.primary_location.source && it.primary_location.source.display_name) || '',
      type: entryTypeOf(it.type, [[/^article$/, 'article'], [/proceedings|conference/, 'inproceedings']]),
      volume: (it.biblio && it.biblio.volume) || '', issue: (it.biblio && it.biblio.issue) || '',
      pages: [(it.biblio && it.biblio.first_page) || '', (it.biblio && it.biblio.last_page) || ''].filter(Boolean).join('-'),
      doi: String(it.doi || '').replace(/^https?:\/\/doi\.org\//, ''),
      url: it.id || '',
      source: 'OpenAlex',
    };
  }).filter(e => e.title);
}

function parseDblp(json) {
  const hits = json && json.result && json.result.hits && json.result.hits.hit;
  const list = Array.isArray(hits) ? hits : [];
  return list.map(h => {
    const info = h.info || {};
    const raw = info.authors && info.authors.author;
    const authors = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(a => familyFirst(a.text || ''));
    return {
      title: info.title || '',
      authors,
      year: info.year ? +info.year : null,
      venue: info.venue || '',
      type: entryTypeOf(info.type, [[/journal/, 'article'], [/conference|workshop/, 'inproceedings']]),
      volume: info.volume || '', issue: '', pages: info.pages || '',
      doi: info.doi || '', url: info.url || '',
      source: 'DBLP',
    };
  }).filter(e => e.title);
}

// ---- BibTeX 生成 ----

/** BibTeX 键：第一作者姓 + 年份 + 标题首个实词；无拉丁姓氏时退回 ref；撞键追加 a/b/c… */
export function makeBibKey(entry, existingKeys) {
  const taken = existingKeys instanceof Set ? existingKeys : new Set(existingKeys || []);
  const first = String((entry.authors || [])[0] || '');
  let name = first.split(',')[0].replace(/[^A-Za-z]/g, '').toLowerCase();
  const titleWord = (String(entry.title || '').match(/[A-Za-z]{4,}/) || ['ref'])[0].toLowerCase();
  if (!name) name = 'ref';
  const base = name + (entry.year || '') + titleWord;
  let key = base, n = 0;
  while (taken.has(key)) {
    n++;
    // 先追加 a…z，超过 26 个变体改用数字，保证有生之年能停
    key = n <= 26 ? base + String.fromCharCode(96 + n) : base + n;
  }
  return key;
}

// 字段值里的 LaTeX 特殊字符转义；花括号保护大小写由调用侧不干预。
// 已知危险原语先中和（前置反斜杠翻倍成字面量）：外部 API 的标题不该能往导言区
// 塞 \input/\write18 这类控制序列——真编译路径会照单执行。不全面禁反斜杠：
// 物理/数学类标题里 $\alpha$ 这类数学是正当内容。
// 黑名单必须带内核形式（\@@input 就是 \input 的原语名，名字里没有字母边界）与
// 定义/展开家族（\def、\csname…\endcsname 能把任意控制序列拼出来）。
const BIB_UNSAFE = /\\(input|@@input|@@@input|include|openin|openout|read|write18?|write|special|immediate|catcode|csname|endcsname|expandafter|noexpand|unexpanded|directlua|luaexec|shellescape|stopmode|batchmode|endinput|def|edef|gdef|xdef|let|futurelet|font|meaning|loop|repeat|dump|global|newcount|newdimen|newbox|relax)\b/gi;

function besc(s) {
  return String(s || '')
    .replace(BIB_UNSAFE, '\\\\$1')
    // 花括号也要转义：不转义就等于跨出字段，投稿者可控的 DOI/标题能注入任意 BibTeX 字段
    .replace(/([{}&%$#_])/g, '\\$1');
}

/** 条目 → BibTeX 文本。期刊用 @article(journal=)，会议用 @inproceedings(booktitle=)，其余 @misc */
export function entryToBibTeX(entry, key) {
  const type = entry.type === 'article' || entry.type === 'inproceedings' ? entry.type : 'misc';
  const fields = [];
  const push = (k, v) => { if (v != null && String(v).trim()) fields.push('  ' + k + ' = {' + besc(v) + '}'); };
  push('author', (entry.authors || []).join(' and '));
  push('title', entry.title);
  if (type === 'article') push('journal', entry.venue);
  else if (type === 'inproceedings') push('booktitle', entry.venue);
  push('year', entry.year);
  push('volume', entry.volume);
  push('number', entry.issue);
  push('pages', entry.pages);
  push('doi', entry.doi);
  push('url', entry.url);
  return '@' + type + '{' + key + ',\n' + fields.join(',\n') + '\n}';
}

/** 从文档源码里解析 \\bibliography{a,b} / \\addbibresource{refs.bib} 引用的 .bib 文件名 */
export function referencedBibFiles(text) {
  const out = [];
  const re = /\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    for (const part of m[1].split(',')) {
      const n = part.trim();
      if (n) out.push(/\.bib$/i.test(n) ? n : n + '.bib');
    }
  }
  return out;
}
