// Snapshot the entry document's directory, including binary figures. Open editor
// buffers override disk files so compilation also includes unsaved edits.
const INPUT = /\.(tex|sty|cls|bib|bst|bbx|cbx|def|cfg|clo|fd|pdf|png|jpe?g|eps|svg|otf|ttf|dat|csv|txt)$/i;
const SKIP = new Set(['.git', 'node_modules', 'dist', '.vite', '__pycache__']);

export async function collectCompileFiles(entry, tabs, signal) {
  const files = new Map();
  let total = 0;
  const put = (name, bytes) => {
    total += bytes.byteLength - (files.get(name)?.byteLength || 0);
    if (total > 100 * 1024 * 1024) throw new Error('LaTeX project exceeds 100 MB');
    files.set(name, bytes);
  };
  const visit = async (dir, prefix = '') => {
    for await (const [name, handle] of dir.entries()) {
      // 取消后别把整个目录继续读完：大目录下取消编译要等遍历完才生效
      if (signal?.aborted) throw new Error('cancelled');
      if (SKIP.has(name)) continue;
      const path = prefix + name;
      if (handle.kind === 'directory') await visit(handle, path + '/');
      else if (INPUT.test(name)) {
        const file = await handle.getFile();
        if (file.size > 100 * 1024 * 1024 - total) throw new Error('LaTeX project exceeds 100 MB');
        put(path, new Uint8Array(await file.arrayBuffer()));
      }
    }
  };
  if (entry.parentDir) await visit(entry.parentDir);
  for (const tab of tabs) {
    let name = tab.name;
    if (entry.parentDir && tab.handle) {
      const parts = await entry.parentDir.resolve(tab.handle);
      if (!parts) continue;
      name = parts.join('/');
    }
    // 无 handle（新建未保存的标签）按文件名参与编译：内容在编辑器里是齐全的，
    // 跳过会让 \input 读到磁盘旧版、或直接报找不到这个文件（磁盘内容已在上面被覆盖）
    if (!INPUT.test(name)) continue;
    if (tab.doc) put(name, new TextEncoder().encode(tab.doc.getValue()));
    else if (tab.uploadedFile) put(name, new Uint8Array(await tab.uploadedFile.arrayBuffer()));
  }
  // The WASM pipeline uses a stable job name, independently of the editor name.
  files.delete('main.tex');
  return [...files].map(([name, bytes]) => ({ name, bytes }));
}
