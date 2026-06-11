const https = require('https');

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode >= 400) {
              reject(new Error(`LLM API 错误 ${res.statusCode}: ${JSON.stringify(parsed)}`));
            } else {
              resolve(parsed);
            }
          } catch {
            reject(new Error('LLM API 响应解析失败'));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callLLM({ provider, model, apiKey, messages }) {
  if (provider === 'openai') {
    const body = JSON.stringify({ model, messages });
    const data = await httpsPost(
      'api.openai.com', '/v1/chat/completions',
      { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body
    );
    return data.choices[0].message.content;
  }

  if (provider === 'anthropic') {
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');
    const body = JSON.stringify({ model, max_tokens: 4096, system: systemMsg?.content || '', messages: chatMessages });
    const data = await httpsPost(
      'api.anthropic.com', '/v1/messages',
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body
    );
    return data.content[0].text;
  }

  throw new Error(`暂不支持的 LLM 厂商: ${provider}`);
}

module.exports = { callLLM };
