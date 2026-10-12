import { useCallback, useEffect, useState } from 'react';
import { listDir, removeEntry, renameEntry, canRename, createFile, createDirectory } from '../fs.js';
import { infoFor } from '../fileTypes.js';

/* 文件树：懒加载展开；文件点击打开；悬停操作（新建/重命名/删除） */
export default function FileTree({ root, onOpenFile, onCloseFolder, refreshKey }) {
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
      setChildren(c => ({ ...c, [path]: [{ name: '（读取失败：' + (e.message || e) + '）', kind: 'error' }] }));
    }
    setLoading(l => ({ ...l, [path]: false }));
  }, []);

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
    const name = prompt('新建文件名（含扩展名）：');
    if (!name) return;
    try {
      await createFile(dir, name);
      refresh(dirPath);
      const fh = await dir.getFileHandle(name);
      onOpenFile(fh, (dirPath ? dirPath + '/' : '') + name, dir);
    } catch (e) { alert('新建失败：' + (e.message || e)); }
  };

  const doNewDir = async (dirPath) => {
    const dir = parentHandle(dirPath);
    if (!dir) return;
    const name = prompt('新建文件夹名：');
    if (!name) return;
    try { await createDirectory(dir, name); refresh(dirPath); }
    catch (e) { alert('新建失败：' + (e.message || e)); }
  };

  const doRename = async (entry) => {
    const name = prompt('重命名为：', entry.name);
    if (!name || name === entry.name) return;
    try {
      await renameEntry(entry.handle, name);
      const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
      refresh(parent);
    } catch (e) { alert('重命名失败：' + (e.message || e)); }
  };

  const doDelete = async (entry) => {
    const parent = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
    const dir = parentHandle(parent);
    if (!dir) return;
    if (!window.confirm(`删除「${entry.name}」${entry.kind === 'directory' ? '及其全部内容' : ''}？此操作不可撤销。`)) return;
    try {
      await removeEntry(dir, entry.name, entry.kind === 'directory');
      refresh(parent);
    } catch (e) { alert('删除失败：' + (e.message || e)); }
  };

  const renderNodes = (entries, depth) => entries.map(entry => {
    if (entry.kind === 'error') {
      return <div key={entry.name} className="ft-error" style={{ paddingLeft: depth * 12 + 20 }}>{entry.name}</div>;
    }
    const isDir = entry.kind === 'directory';
    const icon = isDir ? (expanded[entry.path] ? '📂' : '📁') : infoFor(entry.name).icon;
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
              <button title="在此新建文件" onClick={e => { e.stopPropagation(); doNewFile(entry.path); }}>＋📄</button>
              <button title="在此新建文件夹" onClick={e => { e.stopPropagation(); doNewDir(entry.path); }}>＋📁</button>
            </>}
            <button title="重命名" disabled={!canRename(entry.handle)} onClick={e => { e.stopPropagation(); doRename(entry); }}>✏️</button>
            <button title="删除" onClick={e => { e.stopPropagation(); doDelete(entry); }}>🗑</button>
          </span>
        </div>
        {isDir && expanded[entry.path] && (
          <div className="ft-children">
            {loading[entry.path] ? <div className="ft-hint" style={{ paddingLeft: depth * 12 + 28 }}>加载中…</div>
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
        <span className="ft-title">📁 {root.name}</span>
        <span className="ft-acts ft-head-acts">
          <button title="根目录新建文件" onClick={() => doNewFile('')}>＋📄</button>
          <button title="根目录新建文件夹" onClick={() => doNewDir('')}>＋📁</button>
          <button title="刷新" onClick={() => load(root, '')}>⟳</button>
          <button title="关闭文件夹" onClick={onCloseFolder}>✕</button>
        </span>
      </div>
      <div className="ft-body">
        {loading[''] && !rootEntries.length ? <div className="ft-hint">加载中…</div> : renderNodes(rootEntries, 0)}
      </div>
    </div>
  );
}
