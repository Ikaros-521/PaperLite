/* 文献检索纯逻辑测试：三个数据源归一化、BibTeX 键生成与转义、\bibliography 解析 */
import { parseCrossref, parseOpenAlex, parseDblp, familyFirst, makeBibKey, entryToBibTeX, referencedBibFiles, PROVIDERS } from '../src/citation.js';

const crossrefFixture = {
  message: { items: [
    {
      DOI: '10.5555/3295222', title: ['Attention Is All You Need'],
      author: [{ family: 'Vaswani', given: 'Ashish' }, { family: 'Shazeer', given: 'Noam' }],
      issued: { 'date-parts': [[2017]] }, 'container-title': ['Advances in Neural Information Processing Systems'],
      type: 'journal-article', volume: '30', page: '5998-6008', URL: 'https://doi.org/10.5555/3295222',
    },
    {
      DOI: '10.1145/xyz', title: ['A Conference Paper'],
      author: [{ family: 'Doe', given: 'Jane' }],
      issued: { 'date-parts': [[2020]] }, 'container-title': ['Proc. of Something'],
      type: 'proceedings-article',
    },
    { DOI: '10.no/title', author: [], type: 'journal-article' },  // 无标题：应被过滤
  ] },
};
const openalexFixture = {
  results: [{
    display_name: 'Deep Residual Learning for Image Recognition',
    authorships: [{ author: { display_name: 'Kaim He' } }, { author: { display_name: 'Xiangyu Zhang' } }],
    publication_year: 2016,
    primary_location: { source: { display_name: 'CVPR' } },
    doi: 'https://doi.org/10.1109/CVPR.2016.90',
    biblio: { volume: '', issue: '', first_page: '770', last_page: '778' },
    type: 'article',
    id: 'https://openalex.org/W1',
  }],
};
const dblpFixture = {
  result: { hits: { hit: [{ info: {
    title: 'Deep Residual Learning for Image Recognition',
    authors: { author: [{ text: 'Kaim He' }, { text: 'Xiangyu Zhang' }] },
    venue: 'IEEE Trans. Pattern Anal. Mach. Intell.', year: '2016', type: 'Journal Articles',
    doi: '10.1109/TPAMI.2016', url: 'https://dblp.org/rec/x',
  } }] } },
};

const parseCrossrefFixture = () => parseCrossref(crossrefFixture);
const parseOpenAlexFixture = () => parseOpenAlex(openalexFixture);
const parseDblpFixture = () => parseDblp(dblpFixture);

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

console.log('== familyFirst ==');
ok(familyFirst('San Zhang') === 'Zhang, San', '全名转 family-first');
ok(familyFirst('Zhang, San') === 'Zhang, San', '已是逗号形式原样返回');
ok(familyFirst('Einstein') === 'Einstein', '单名原样返回');
ok(familyFirst('') === '', '空名返回空');

console.log('== Crossref 归一化 ==');
let list = parseCrossrefFixture();
ok(list.length === 2, '两条结果：' + list.length);
ok(list[0].title === 'Attention Is All You Need', '标题');
ok(list[0].authors[0] === 'Vaswani, Ashish', '作者 family-first');
ok(list[0].year === 2017 && list[0].venue === 'Advances in Neural Information Processing Systems', '年份与期刊');
ok(list[0].type === 'article', 'journal-article → article');
ok(list[1].type === 'inproceedings', 'proceedings-article → inproceedings');

console.log('== OpenAlex 归一化 ==');
list = parseOpenAlexFixture();
ok(list.length === 1 && list[0].authors[0] === 'He, Kaim', '全名转 family-first：' + list[0].authors[0]);
ok(list[0].doi === '10.1109/CVPR.2016.90', 'DOI 去掉 https://doi.org/ 前缀');
ok(list[0].pages === '770-778', '首末页拼 pages');

console.log('== DBLP 归一化 ==');
list = parseDblpFixture();
ok(list.length === 1 && list[0].source === 'DBLP', 'DBLP 来源标记');
ok(list[0].type === 'article' && list[0].venue === 'IEEE Trans. Pattern Anal. Mach. Intell.', 'Journal Articles → article + venue');

console.log('== makeBibKey ==');
const entry = { title: 'Deep Residual Learning for Image Recognition', authors: ['He, Kaim'], year: 2016 };
ok(makeBibKey(entry, []) === 'he2016deep', '基础键：姓+年+标题实词');
ok(makeBibKey(entry, ['he2016deep']) === 'he2016deepa', '撞键追加 a');
ok(makeBibKey(entry, ['he2016deep', 'he2016deepa']) === 'he2016deepb', '继续追加 b');
ok(makeBibKey({ title: '深度残差网络研究', authors: ['何恺明'], year: 2020 }, []) === 'ref2020ref', '无拉丁姓/词时退回 ref2020ref');
ok(makeBibKey({ title: 'A Study', authors: [], year: null }, []) === 'refstudy', '缺年份与作者的兜底');

console.log('== entryToBibTeX ==');
let bib = entryToBibTeX({ title: 'R&D in AI: 100% Value & _Cost', authors: ['A, B', 'C, D'], year: 2024, venue: 'J. of Testing', type: 'article', doi: '10.1/x' }, 'a2024rnd');
ok(bib.startsWith('@article{a2024rnd,'), '@article 头');
ok(bib.includes('journal = {J. of Testing}'), 'article 用 journal 字段');
ok(bib.includes('R\\&D'), '& 转义');
ok(bib.includes('100\\%'), '% 转义');
ok(bib.includes('\\_Cost'), '_ 转义');
ok(bib.includes('author = {A, B and C, D}'), '作者 and 连接');
bib = entryToBibTeX({ title: 'T', venue: 'Proc. of X', type: 'inproceedings', year: 2023 }, 'k');
ok(bib.includes('@inproceedings{k,') && bib.includes('booktitle = {Proc. of X}'), 'inproceedings 用 booktitle');
bib = entryToBibTeX({ title: 'T', year: 2024 }, 'k2');
ok(bib.startsWith('@misc{k2,'), '无 venue 类型退 @misc');
ok(!/volume|number|pages|doi|url/.test(bib), '空字段不输出');

console.log('== referencedBibFiles ==');
ok(JSON.stringify(referencedBibFiles('\\bibliography{refs}')) === JSON.stringify(['refs.bib']), '裸名补 .bib');
ok(JSON.stringify(referencedBibFiles('\\bibliography{a,b}')) === JSON.stringify(['a.bib', 'b.bib']), '逗号多文件');
ok(JSON.stringify(referencedBibFiles('\\addbibresource[online]{my refs.bib}')) === JSON.stringify(['my refs.bib']), 'addbibresource 带选项且保留空格');
ok(referencedBibFiles('no bibliography here').length === 0, '无引用返回空');

console.log('== 检索 URL 可构造 ==');
for (const p of Object.keys(PROVIDERS)) {
  const url = PROVIDERS[p].url('深度学习 deep learning');
  ok(/^https:\/\/[a-z.]+\//.test(url) && encodeURIComponent('深度学习 deep learning').slice(0, 10).length > 0 && !url.includes(' '), p + ' URL 编码且无裸空格');
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
