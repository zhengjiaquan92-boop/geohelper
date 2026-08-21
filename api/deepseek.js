// Vercel Serverless Function - DeepSeek API Proxy
// 用途：解决浏览器 CORS 问题 —— 浏览器 → 本代理 → DeepSeek API

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const TIMEOUT_MS = 30_000; // 上游请求超时 30 秒

// 统一 CORS 头，避免重复写
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default async function handler(req, res) {
  // 1. CORS 预检请求
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(200).end();
  }

  // 2. 只允许 POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 3. 校验 API Key（客户端放在 Authorization 头）
  const apiKey = req.headers['authorization'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  // 客户端是否要求流式返回
  const isStream = req.body && req.body.stream === true;

  // 超时控制
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: apiKey,
      },
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });

    // 所有响应都带上 CORS 头
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      res.setHeader(key, value);
    }

    // 流式：直接把上游 SSE 流转发出去
    if (isStream && upstream.ok && upstream.body) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.status(200);

      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
      clearTimeout(timer);
      return;
    }

    // 非流式：先读成文本，再尝试转 JSON，避免空 body 崩溃
    const text = await upstream.text();
    clearTimeout(timer);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    res.status(upstream.status).json(data);
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: 'Upstream request timed out' });
    }
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Proxy error: ' + error.message });
  }
}
