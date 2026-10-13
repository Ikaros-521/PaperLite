import { useCallback, useEffect, useState } from 'react';
import { listDir, removeEntry, renameEntry, canRename, createFile, createDirectory } from '../fs.js';
import { infoFor } from '../fileTypes.js';
import { useLang, useT } from '../useI18n.js';

/* 文件树：懒加载展开；文件点击打开；悬停操作（新建/重命名/删除） */
export default function FileTree({ root, onOpenFile, onCloseFolder, refreshKey }) {
  const t = useT();
  const lang = useLang();
  const [children, setChildren] = useState({});   // path -> entries[]
  const [expanded, setExpanded] = useState({});   // path -> true
  const [loading, setLoading] = useState({});
  const [selDir, setSelDir] = useState('');       // 当前选中目录 path（新建目标）

  const load = useCallback(async (dirHandle, path) => {
    setLoading(l => ({ ...l, [path]: true }));
    try {
      const entries = await listDir(dirHandle);
      setChildren(c => ({ ...c, [path]: entries }));
    } catch (e) {
      setChildren(c => ({ ...c, [path]: [{ name: t('ft.readFailed', { msg: e.message || e }), kind: 'error' }] }));
    }
    setLoading(l => ({ ...l, [path]: false }));
  }, [t]);

  useEffect(() => {
    if (root) {
      setChildren({});
      setExpanded({});
      setSelDir('');
      load(root, '');
    }
  }, [root, refreshKey, load]);

  const toggle = async (entry) => {
    const path = entry.path;
    if (expanded[path]) {
      setExpanded(e => ({ ...e, [path]: false }));
    } else {
      setExpanded(e => ({ ...e, [path]: true }));
      setSelDir(path);
      if (!children[path]) load(entry.handle, path);
    }
  };

  const refresh = (parentPath) => {
    const dirHandle = parentPath === '' ? root : children[parentPath]?.find(x => x.kind === 'directory' && x.path === parentPath)?.handle;
    if (dirHandle) load(dirHandle, parentPath);
    else load(root, '');
  };

  const parentHandle = (parentPath) => {
    if (parentPath === '') return root;
    // 从 children 缓存里找该目录的 handle（目录项自带）
    const seg = parentPath.split('/');
    let h = root, prefix = '';
    for (const name of seg) {
      prefix = prefix ? prefix + '/' + name : name;
      const hit = (children[prefix] || []).find(x => x.kind === 'directory' && x.name === name);
      if (!hit) return null;
      h = hit.handle;
    }
    return h;
  };

  const doNewFile = async (dirPath) => {
    const dir = parentHandle(dirPath);
    if (!dir) return;
    const name = prompt(t('ft.newFilePrompt'));
    if (!name) return;
    try {
      await createFile(dir, name);
      refresh(dirPath);
      const fh = await dir.getFileHandle(name);
      onOpenFile(fh, (dirPath ? dirPath + '/' : '') + name, dir);
    } catch (e) { alert(t('ft.createFailed', { msg: e.message || e })); }
  };

  const doNewDir = async (dirPath) => {
    const dir = parentHandle(dirPath);
    if (!dir) return;
    const name = prompt(t('ft.newDirPrompt'));
    if (!name) return;
    try { await createDirectory(dir, name); refresh(dirPath); }
    catch (e) { alert(t('ft.createFailed', { msg: e.message || e })); }
  };

  const doRename = async (entry) => {
    const name = prompt(t('ft.renamePrompt'), entry.name);
    if (!name || name === entry.name) return;
    try {
      await renameEntry(entry.handle, name);
      const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
      refresh(parent);
    } catch (e) { alert(t('ft.renameFailed', { msg: e.message || e })); }
  };

  const doDelete = async (entry) => {
    const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
    const dir = parentHandle(parent);
    if (!dir) return;
    if (!window.confirm(t('ft.delConfirm', { name: entry.name, extra: entry.kind === 'directory' ? t('ft.delDirExtra') : '' }))) return;
    try {
      await removeEntry(dir, entry.name, entry.kind === 'directory');
      refresh(parent);
    } catch (e) { alert(t('ft.delFailed', { msg: e.message || e })); }
  };

  const renderNodes = (entries, depth) => entries.map(entry => {
    if (entry.kind === 'error') {
      return <div key={entry.name} className="ft-error" style={{ paddingLeft: depth * 12 + 20 }}>{entry.name}</div>;
    }
    const isDir = entry.kind === 'directory';
    const icon = isDir ? (expanded[entry.path] ? '▾' : '▸') : infoFor(entry.name).icon;
    return (
      <div key={entry.path} className="ft-row-wrap">
        <div
          className={'ft-row' + (selDir === entry.path && isDir ? ' sel' : '')}
          style={{ paddingLeft: depth * 12 + 8 }}
          onClick={() => isDir ? toggle(entry) : onOpenFile(entry.handle, entry.path, null)}
        >
          <span className="ft-icon">{icon}</span>
          <span className="ft-name" title={entry.path}>{entry.name}</span>
          <span className="ft-acts">
            {isDir && <>
              <button title={t('ft.newFileHere')} onClick={e => { e.stopPropagation(); doNewFile(entry.path); }}>{lang === 'zh' ? '＋文' : '＋f'}</button>
              <button title={t('ft.newDirHere')} onClick={e => { e.stopPropagation(); doNewDir(entry.path); }}>{lang === 'zh' ? '＋夹' : '＋d'}</button>
            </>}
            <button title={t('ft.rename')} disabled={!canRename(entry.handle)} onClick={e => { e.stopPropagation(); doRename(entry); }}>✎</button>
            <button title={t('ft.del')} onClick={e => { e.stopPropagation(); doDelete(entry); }}>✕</button>
          </span>
        </div>
        {isDir && expanded[entry.path] && (
          <div className="ft-children">
            {loading[entry.path] ? <div className="ft-hint" style={{ paddingLeft: depth * 12 + 28 }}>{t('ft.loading')}</div>
              : renderNodes(children[entry.path] || [], depth + 1)}
          </div>
        )}
      </div>
    );
  });

  const rootEntries = children[''] || [];

  return (
    <div id="workspace">
      <div className="ft-head">
        <span className="ft-title">{root.name}</span>
        <span className="ft-acts ft-head-acts">
          <button title={t('ft.rootNewFile')} onClick={() => doNewFile('')}>{lang === 'zh' ? '＋文' : '＋f'}</button>
          <button title={t('ft.rootNewDir')} onClick={() => doNewDir('')}>{lang === 'zh' ? '＋夹' : '＋d'}</button>
          <button title={t('ft.refresh')} onClick={() => load(root, '')}>⟳</button>
          <button title={t('ft.closeFolder')} onClick={onCloseFolder}>✕</button>
        </span>
      </div>
      <div className="ft-body">
        {loading[''] && !rootEntries.length ? <div className="ft-hint">{t('ft.loading')}</div> : renderNodes(rootEntries, 0)}
      </div>
    </div>
  );
}
