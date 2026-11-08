/**
 * 极简 HTTP 客户端：用 node:http，不用全局 fetch。
 *
 * 为什么不用 fetch：它只在 Node 18+ 才存在。插件既可能跑在桌面端的 Node 24 里，
 * 也可能在用户的 `dsh web`（Node 22）里，而本项目的测试与排障脚本会在更老的
 * Node 上跑。一次 `fetch is not defined` 就足以让「让桌宠说话」这条链路静默失效，
 * 而症状看起来像「桌宠没装」—— 这种误报比直接报错贵得多。
 *
 * @module dsh-companion-journal/lib/http
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * 发一个 JSON 请求，永不抛：所有失败都收敛成 { ok:false, error }。
 *
 * @param {string} url
 * @param {{method?:string, headers?:object, body?:string, timeoutMs?:number}} options
 * @returns {Promise<{ok:true,status:number,text:string}|{ok:false,status:number,error:string,text?:string}>}
 */
export function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve({ ok: false, status: 0, error: 'bad-url' });
      return;
    }
    const isHttps = target.protocol === 'https:';
    const payload = body === undefined ? null : Buffer.from(body, 'utf8');
    const options = {
      method,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      headers: {
        ...headers,
        ...(payload ? { 'Content-Length': String(payload.length) } : {}),
      },
    };

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let req;
    try {
      req = (isHttps ? httpsRequest : httpRequest)(options, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          // 防御性上限：这些接口都只回很小的 JSON，超过 2MiB 一定是出了别的问题
          // （比如被代理注入了一个登录页），不该把内存撑爆。
          if (size <= 2 * 1024 * 1024) chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          finish({ ok: status >= 200 && status < 300, status, text });
        });
        res.on('error', (error) => finish({ ok: false, status: 0, error: String(error?.message ?? error) }));
      });
    } catch (error) {
      finish({ ok: false, status: 0, error: String(error?.message ?? error) });
      return;
    }

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish({ ok: false, status: 0, error: 'timeout' });
    });
    req.on('error', (error) => {
      const code = error?.code ?? '';
      finish({ ok: false, status: 0, error: code || String(error?.message ?? error) });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** 请求并按 JSON 解析；解析失败时保留原始文本，便于判断「对端不是我们以为的那个服务」。 */
export async function requestParsedJson(url, options) {
  const result = await requestJson(url, options);
  if (!result.ok) return result;
  try {
    return { ...result, value: JSON.parse(result.text) };
  } catch {
    return { ...result, ok: false, error: 'bad-json' };
  }
}
