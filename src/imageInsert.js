/* PaperLite · 插入图片（工具栏按钮 / 编辑器拖拽 / 粘贴共用一条路径）
 *
 * 打开文件夹时优先把图片写进项目目录（重名自动加序号），源码插 \includegraphics / ![]()；
 * 没有文件夹时：Markdown 转 base64 内嵌，LaTeX 开一个内存资源标签（随源码 ZIP 一起带走）。
 * LaTeX 文档缺 graphicx 宏包时顺手补 \usepackage。
 */
import { validName } from './fileActions.js';
import * as fs from './fs.js';
import { infoFor } from './fileTypes.js';
import { makeTab } from './workspace/tabModel.js';

/** 原名去除 LaTeX 不友好字符后，避开已打开标签与磁盘重名，追加 (2)/(3)… 序号 */
export async function pickUniqueName(original, { tabsRef, dir }) {
  if (!validName(original)) throw new Error('bad file name');
  let name = original, suffix = 1;
  for (;;) {
    let exists = (tabsRef.current || []).some(tab => tab.name === name);
    if (dir) {
      try { await dir.getFileHandle(name); exists = true; }
      catch (error) { if (error.name !== 'NotFoundError') throw error; }
    }
    if (!exists) return name;
    const dot = original.lastIndexOf('.');
    name = (dot > 0 ? original.slice(0, dot) : original) + ' (' + suffix++ + ')' + (dot > 0 ? original.slice(dot) : '');
  }
}

/**
 * 把图片/PDF 文件插入当前文档。
 * @param {object} p
 * @param {File} p.file 用户选择的文件
 * @param {object} p.targetDoc CodeMirror.Doc，插入目标
 * @param {{line:number,ch:number}} p.from 插入起点（拖拽时 = 落点，按钮时 = 选区头）
 * @param {{line:number,ch:number}} p.to 插入终点（选区尾；纯插入时与 from 相同）
 * @param {boolean} p.isMd 目标是 Markdown（无文件夹时走 base64）
 * @param {object|null} p.dir 写入目录（activeTab.parentDir || rootDir）
 * @param {{current:Array}} p.tabsRef / {Function} p.setTabs / {Function} p.onTreeChanged
 * @param {Function} p.t / {Function} p.alertBox
 */
export async function insertImageFile({ file, targetDoc, from, to, isMd, dir, tabsRef, setTabs, onTreeChanged, t, alertBox }) {
  try {
    if (isMd && !dir && !/\.pdf$/i.test(file.name)) {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error); reader.readAsDataURL(file);
      });
      targetDoc.replaceRange('\n![' + file.name + '](' + data + ')\n', from, to, '+input');
      return;
    }
    const original = file.name.replace(/[%#{}~^]/g, '_');
    const name = await pickUniqueName(original, { tabsRef, dir });
    if (dir) {
      const handle = await fs.createFile(dir, name);
      const writable = await handle.createWritable();
      await writable.write(file); await writable.close();
      onTreeChanged && onTreeChanged();
    } else {
      const asset = makeTab({ name, kind: infoFor(name).kind, imageUrl: URL.createObjectURL(file) });
      asset.uploadedFile = file;
      setTabs(ts => ts.concat(asset));
    }
    const snippet = isMd ? '\n' + (/\.pdf$/i.test(name) ? '' : '!') + '[' + name + '](' + name + ')\n'
      : '\n\\begin{figure}[h]\n\\centering\n\\includegraphics[width=0.7\\textwidth]{' + name + '}\n\\caption{' + t('app.imageCaption') + '}\n\\label{fig:img-' + Date.now() + '}\n\\end{figure}\n';
    targetDoc.replaceRange(snippet, from, to, '+input');
    if (!isMd) {
      const value = targetDoc.getValue();
      if (!/\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{[^}]*\bgraphicx\b/.test(value)) {
        const begin = value.search(/^[ \t]*\\begin\s*\{document\}/m);
        if (begin >= 0) targetDoc.replaceRange('\\usepackage{graphicx}\n', targetDoc.posFromIndex(begin), undefined, '+input');
      }
    }
  } catch (error) {
    alertBox && alertBox(t('file.uploadFailed', { name: file.name, msg: error.message }));
  }
}
