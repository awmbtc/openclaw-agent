// OpenClaw Agent 服务 — 使用真实 openclaw 框架（subprocess）
const express    = require('express');
const { execFile } = require('child_process');
const fs         = require('fs/promises');
const path       = require('path');
const os         = require('os');
const { restoreState, saveState } = require('./state');

const app = express();
app.use(express.json());

app.get('/health', (_, res) => res.json({ status: 'ok', agent: 'openclaw' }));

app.post('/run', async (req, res) => {
  const { userId, message, llmProvider, llmModel, apiKey, systemPrompt } = req.body;

  if (!userId || !message || !llmProvider || !llmModel || !apiKey) {
    return res.status(400).json({ error: '缺少必要参数: userId / message / llmProvider / llmModel / apiKey' });
  }

  // 为此用户创建本次请求的独立临时目录
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `oc-${userId}-`));

  try {
    // 1. 从 GCS 恢复该用户的 openclaw 状态
    await restoreState(userId, tempDir);

    // 2. 写入最小配置（模型 + 禁用不必要的 gateway 功能）
    await writeConfig(tempDir, llmProvider, llmModel, systemPrompt);

    // 3. 构建环境变量（API Key 注入，不写入磁盘）
    const env = buildEnv(llmProvider, apiKey);

    // 4. 运行 openclaw agent
    const reply = await runOpenClaw(message, tempDir, env);

    // 5. 将更新后的状态（记忆、技能等）同步回 GCS
    await saveState(userId, tempDir);

    res.json({ reply });

  } catch (err) {
    console.error('[openclaw] 执行失败:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    // 清理临时目录
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * 写入最小 openclaw.json 配置
 * 每次写入确保模型设置是最新的（用户可能在设置页修改了模型）
 */
async function writeConfig(stateDir, llmProvider, llmModel, systemPrompt) {
  const configDir = path.join(stateDir, '.openclaw');
  await fs.mkdir(configDir, { recursive: true });

  const providerModel = `${llmProvider}/${llmModel}`;

  const config = {
    agents: {
      defaults: {
        workspace: path.join(stateDir, 'workspace'),
        model: {
          primary: providerModel,
        },
        // 禁用心跳等后台任务，专注于单次请求
        heartbeat: { every: '0m' },
      },
    },
    // 关闭所有 channel（我们不需要 Telegram/Discord 等）
    gateway: {
      channelHealthCheckMinutes: 0,
    },
  };

  // 如果有自定义 system prompt，写入 SOUL.md
  if (systemPrompt) {
    const workspaceDir = path.join(stateDir, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    const soulPath = path.join(workspaceDir, 'SOUL.md');
    const existing  = await fs.readFile(soulPath, 'utf8').catch(() => null);
    if (!existing) {
      await fs.writeFile(soulPath, systemPrompt, 'utf8');
    }
  }

  await fs.writeFile(
    path.join(configDir, 'openclaw.json'),
    JSON.stringify(config, null, 2),
    'utf8'
  );
}

/**
 * 构建执行环境变量
 */
function buildEnv(provider, apiKey) {
  const env = { ...process.env };
  if (provider === 'openai')    env.OPENAI_API_KEY    = apiKey;
  if (provider === 'anthropic') env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

/**
 * 以 subprocess 方式运行 openclaw agent
 * OPENCLAW_STATE_DIR 指向该用户的独立临时目录
 */
function runOpenClaw(message, stateDir, env) {
  return new Promise((resolve, reject) => {
    const args = [
      'agent',
      '--message', message,
      '--output-format', 'text',  // 纯文本输出，不含 ANSI 颜色码
    ];

    const proc = execFile('openclaw', args, {
      env: {
        ...env,
        OPENCLAW_STATE_DIR: path.join(stateDir, '.openclaw'),
        OPENCLAW_HOME:      stateDir,
      },
      timeout: 55000, // 55s，Cloud Run 默认 60s 超时
    }, (err, stdout, stderr) => {
      if (err) {
        // 输出 stderr 方便排查
        console.error('[openclaw stderr]', stderr);
        reject(new Error(stderr?.trim() || err.message));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on('error', reject);
  });
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ openclaw-agent (real) 运行中 → port ${PORT}`));
