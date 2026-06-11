// OpenClaw Agent 服务
// TODO: 替换为 openclaw/openclaw npm 包（CLI: openclaw agent --message "..."）
const express = require('express');
const { callLLM } = require('./llm');

const app = express();
app.use(express.json());

app.get('/health', (_, res) => res.json({ status: 'ok', agent: 'openclaw' }));

app.post('/run', async (req, res) => {
  const { message, history = [], memory = [], systemPrompt, llmProvider, llmModel, apiKey } = req.body;

  if (!message || !llmProvider || !llmModel || !apiKey) {
    return res.status(400).json({ error: '缺少必要参数: message / llmProvider / llmModel / apiKey' });
  }

  const memoryContext = memory.length
    ? `\n\n用户记忆：\n${memory.map(m => `${m.key}: ${m.value}`).join('\n')}`
    : '';

  const messages = [
    { role: 'system', content: (systemPrompt || '') + memoryContext },
    ...history,
    { role: 'user', content: message },
  ];

  try {
    const reply = await callLLM({ provider: llmProvider, model: llmModel, apiKey, messages });
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ openclaw-agent 运行中 → port ${PORT}`));
