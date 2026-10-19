import { useCallback, useEffect, useRef, useState } from 'react';
import { listDir, removeEntry, renameEntry, canRename, createFile, createDirectory } from '../fs.js';
import { validName } from '../fileActions.js';
import { infoFor } from '../fileTypes.js';
import { useLang, useT } from '../useI18n.js';
import { showAlert as alert, showConfirm, showPrompt } from '../dialogs.js';

/* 文件树：懒加载展开；文件点击打开；悬停操作（新建/重命名/删除） */
export default function FileTree({ root, onOpenFile, onCloseFolder, refreshKey, onRenamed }) {
  const t = useT();
  const lang = useLang();
  const [children, setChildren] = useState({});   // path -> entries[]
  const [expanded, setExpanded] = useState({});   // path -> true
  const [loading, setLoading] = useState({});
  const [selDir, setSelDir] = useState('');       // 当前选中目录 path（新建目标）
  const rootRef = useRef(null);
  const childrenRef = useRef(children);
  const requestsRef = useRef({});
  childrenRef.current = children;

  const load = useCallback(async (dirHandle, path) => {
    const request = {};
    requestsRef.current[path] = request;
    const isCurrent = () => rootRef.current === root && requestsRef.current[path] === request;
    setLoading(l => ({ ...l, [path]: true }));
    try {
      const entries = await listDir(dirHandle);
      if (!isCurrent()) return;
      setChildren(c => ({ ...c, [path]: entries.map(entry => ({ ...entry,
        path: path ? path + '/' + entry.name : entry.name })) }));
    } catch (e) {
      if (!isCurrent()) return;
      setChildren(c => ({ ...c, [path]: [{ name: t('ft.readFailed', { msg: e.message || e }), kind: 'error' }] }));
    }
    setLoading(l => ({ ...l, [path]: false }));
  }, [root, t]);

  const parentHandle = useCallback((parentPath) => {
    if (parentPath === '') return root;
    // 目录 handle 存在父层的目录项中。
    let h = root, prefix = '';
    for (const name of parentPath.split('/')) {
      const hit = (childrenRef.current[prefix] || []).find(x => x.kind === 'directory' && x.name === name);
      if (!hit) return null;
      h = hit.handle;
      prefix = prefix ? prefix + '/' + name : name;
    }
    return h;
  }, [root]);

  const refreshTree = useCallback(() => {
    if (!root) return;
    // 更新所有已加载层级，折叠目录再次展开时也能看到最新内容。
    const paths = new Set(['', ...Object.keys(childrenRef.current), ...Object.keys(requestsRef.current)]);
    for (const path of paths) {
      const handle = parentHandle(path);
      if (handle) load(handle, path);
    }
  }, [root, parentHandle, load]);

  useEffect(() => {
    if (rootRef.current !== root) {
      rootRef.current = root;
      childrenRef.current = {};
      requestsRef.current = {};
      setChildren({});
      setExpanded({});
      setLoading({});
      setSelDir('');
    }
    refreshTree();
  }, [root, refreshKey, refreshTree]);

  useEffect(() => () => { requestsRef.current = {}; }, []);

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
    const dirHandle = parentHandle(parentPath);
    if (dirHandle) load(dirHandle, parentPath);
  };

  const doNewFile = async (dirPath) => {
    const dir = parentHandle(dirPath);
    if (!dir) return;
    const name = await showPrompt(t('ft.newFilePrompt'));
    if (!name) return;
    if (!validName(name)) { alert(t('app.badFileName')); return; }
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
    const name = await showPrompt(t('ft.newDirPrompt'));
    if (!name) return;
    if (!validName(name)) { alert(t('app.badFileName')); return; }
    try { await createDirectory(dir, name); refresh(dirPath); }
    catch (e) { alert(t('ft.createFailed', { msg: e.message || e })); }
  };

  const doRename = async (entry) => {
    const name = await showPrompt(t('ft.renamePrompt'), entry.name);
    if (!name || name === entry.name) return;
    if (!validName(name)) { alert(t('app.badFileName')); return; }
    try {
      const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
      const handle = await renameEntry(entry.handle, name, parentHandle(parent));
      // 先让已打开的标签跟着改名，再刷新树：顺序反了会短暂出现「树新名 + 标签旧名」，
      // 而标签此时保存写的还是旧路径
      onRenamed?.(entry.path, handle, name);
      refresh(parent);
    } catch (e) { alert(t('ft.renameFailed', { msg: e.message || e })); }
  };

  const doDelete = async (entry) => {
    const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
    const dir = parentHandle(parent);
    if (!dir) return;
    if (!await showConfirm(t('ft.delConfirm', { name: entry.name, extra: entry.kind === 'directory' ? t('ft.delDirExtra') : '' }),
      { danger: true, confirmLabel: t('ft.del') })) return;
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
          onClick={() => isDir ? toggle(entry) : onOpenFile(entry.handle, entry.path,
            parentHandle(entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''))}
        >
          <span className="ft-icon">{icon}</span>
          <span className="ft-name" title={entry.path}>{entry.name}</span>
          <span className="ft-acts">
            {isDir && <>
              <button title={t('ft.refresh')} aria-label={t('ft.refresh') + ' ' + entry.name} disabled={!!loading[entry.path]}
                onClick={e => { e.stopPropagation(); refresh(entry.path); }}>⟳</button>
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
          <button className="ft-refresh" title={t('ft.refresh')} aria-label={t('ft.refresh')} disabled={Object.values(loading).some(Boolean)}
            onClick={refreshTree}>⟳ <span>{t(Object.values(loading).some(Boolean) ? 'ft.refreshing' : 'ft.refresh')}</span></button>
          <button title={t('ft.closeFolder')} onClick={onCloseFolder}>✕</button>
        </span>
      </div>
      <div className="ft-body">
        {loading[''] && !rootEntries.length ? <div className="ft-hint">{t('ft.loading')}</div> : renderNodes(rootEntries, 0)}
      </div>
    </div>
  );
}
