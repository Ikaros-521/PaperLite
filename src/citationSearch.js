/**
 * 文献检索网络层：浏览器直连公共学术 API（Crossref / OpenAlex / DBLP），无后端中转。
 * 桌面 <dialog> 与移动端 Popup 共用这一份 fetch + 解析路径，界面只管各自降级提示。
 * 取消与超时由调用方持有 AbortController 控制，这里不做隐藏计时器。
 */
import { PROVIDERS } from './citation.js';

/**
 * @param {string} provider PROVIDERS 里的键（crossref / openalex / dblp）
 * @param {string} query 非空检索词（调用方先 trim）
 * @param {AbortSignal} [signal] 可选取消信号
 * @returns {Promise<Array<{title:string,authors:string[],venue:string,year:string,source:string}>>}
 *   HTTP 非 2xx 抛 Error('HTTP xxx')，由调用方决定文案
 */
export async function searchCitations(provider, query, signal) {
  if (!PROVIDERS[provider]) return Promise.reject(new Error('unknown provider: ' + provider));
  const r = await fetch(PROVIDERS[provider].url(query), { signal: signal || undefined });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return PROVIDERS[provider].parse(await r.json());
}
