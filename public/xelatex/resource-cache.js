// Populate the same in-memory cache used by kpathsea's synchronous file lookup.
// Loaded after the engine glue; FS and texlive200_cache belong to that runtime.
const engineMessageHandler = self.onmessage;
// The main thread tags each command with an increasing reqId and ignores replies
// for another request. Echoing it here lets a reply that arrives after the caller
// timed out never be consumed by the next command on this Worker.
let currentReqId;
const enginePostMessage = self.postMessage;
self.postMessage = function (message, transfer) {
  if (currentReqId !== undefined && message && typeof message === 'object' && message.reqId === undefined) {
    message = Object.assign({}, message, { reqId: currentReqId });
  }
  return enginePostMessage.call(this, message, transfer);
};
self.onmessage = function (event) {
  const data = event.data || {};
  currentReqId = typeof data.reqId === 'number' ? data.reqId : undefined;
  if (data.cmd === 'writeproject') {
    try {
      for (const { name, bytes } of data.files || []) {
        if (!name || name.startsWith('/') || /[\\\u0000]/.test(name)
            || name.split('/').some(part => !part || part === '.' || part === '..')) {
          throw new Error('Invalid project path: ' + name);
        }
        const target = WORKROOT + '/' + name;
        FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
        FS.writeFile(target, new Uint8Array(bytes));
      }
      self.postMessage({ cmd: data.cmd, result: 'ok' });
    } catch (error) {
      self.postMessage({ cmd: data.cmd, result: 'failed', error: String(error) });
    }
    return;
  }
  if (data.cmd === 'gettexlivecache') {
    self.postMessage({ cmd: data.cmd, files: Object.keys(texlive200_cache) });
    return;
  }
  if (data.cmd !== 'cachetexlivefile') return engineMessageHandler(event);
  const key = data.key;
  try {
    if (!self.texlive_files?.has(key) || !/^\d+\/[^/\\]+$/.test(key)) {
      throw new Error('Invalid TeX cache key');
    }
    if (!(key in texlive200_cache)) {
      // XeTeX serializes native font basenames into XDV. dvipdfmx must be able
      // to resolve those names in its own cache/mirror, including fonts it has
      // never loaded. Keep OpenType names identical to demand-loaded fonts.
      // Other formats retain their namespace to avoid same-name collisions.
      const savepath = TEXCACHEROOT + '/' + (key.startsWith('47/')
        ? key.slice(3) : 'preloaded-' + key.replace('/', '-'));
      FS.writeFile(savepath, new Uint8Array(data.src));
      texlive200_cache[key] = savepath;
      delete texlive404_cache[key];
    }
    self.postMessage({ cmd: data.cmd, key, result: 'ok' });
  } catch (error) {
    self.postMessage({ cmd: data.cmd, key, result: 'failed', error: String(error) });
  }
};
