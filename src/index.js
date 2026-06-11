// OpenClaw Agent 服务 — 使用真实 openclaw 框架（subprocess）
const express    = require('express');
const { execFile } = require('child_process');
const crypto     = require('crypto');
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
  let phase = 'restore';

  try {
    // 1. 从 GCS 恢复该用户的 openclaw 状态
    await restoreState(userId, tempDir);

    // 2. 写入最小配置（模型 + 禁用不必要的 gateway 功能）
    phase = 'config';
    const gatewayAuth = createGatewayAuth();
    await writeConfig(tempDir, llmProvider, llmModel, systemPrompt, gatewayAuth);

    // 3. 构建环境变量（API Key 注入，不写入磁盘）
    phase = 'env';
    const env = buildEnv(llmProvider, apiKey);

    // 4. 运行 openclaw agent
    phase = 'run';
    const reply = await runOpenClaw(message, tempDir, env, userId);

    // 5. 将更新后的状态（记忆、技能等）同步回 GCS；状态备份失败不能吞掉已生成的回复
    phase = 'save';
    try {
      await saveState(userId, tempDir);
    } catch (stateErr) {
      console.error('[state] 保存失败，已返回本次回复:', stateErr.message);
    }

    res.json({ reply });

  } catch (err) {
    console.error(`[openclaw] 执行失败 phase=${phase}:`, err.message);
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
async function writeConfig(stateDir, llmProvider, llmModel, systemPrompt, gatewayAuth) {
  const configDir = path.join(stateDir, '.openclaw');
  const workspaceDir = path.join(stateDir, 'workspace');
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });

  const providerModel = `${llmProvider}/${llmModel}`;

  const config = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: {
          primary: providerModel,
        },
        skipBootstrap: true,
        contextInjection: 'never',
        // 禁用心跳等后台任务，专注于单次请求
        heartbeat: { every: '0m' },
      },
    },
    // MVP 聊天先禁用文件/运行时工具，避免模型把目录当文件读取导致 EISDIR
    tools: {
      profile: 'minimal',
    },
    // 强制 local gateway，并写入本次请求的一次性凭据，避免 CLI 默认走需配对的 websocket 模式
    gateway: {
      mode: 'local',
      auth: gatewayAuth,
      channelHealthCheckMinutes: 0,
    },
  };

  await ensureWorkspaceFile(workspaceDir, 'AGENTS.md', 'You are OpenClaw. Answer clearly and helpfully.\n');
  await ensureWorkspaceFile(workspaceDir, 'SOUL.md', systemPrompt || 'Be concise, practical, and helpful.\n');
  await ensureWorkspaceFile(workspaceDir, 'TOOLS.md', 'Tools are disabled for this hosted MVP chat runtime.\n');
  await ensureWorkspaceFile(workspaceDir, 'USER.md', 'User profile is managed by OpenClaw SaaS.\n');
  await ensureWorkspaceFile(workspaceDir, 'IDENTITY.md', 'OpenClaw hosted agent.\n');
  await ensureWorkspaceFile(workspaceDir, 'HEARTBEAT.md', '');
  await ensureWorkspaceFile(workspaceDir, 'BOOTSTRAP.md', '');
  await ensureWorkspaceFile(workspaceDir, 'MEMORY.md', '');

  await fs.writeFile(
    path.join(configDir, 'openclaw.json'),
    JSON.stringify(config, null, 2),
    'utf8'
  );
}

async function ensureWorkspaceFile(workspaceDir, filename, content) {
  const filePath = path.join(workspaceDir, filename);
  const existing = await fs.lstat(filePath).catch(() => null);
  if (existing?.isFile()) {
    return;
  }
  if (existing) {
    await fs.rm(filePath, { recursive: true, force: true });
  }
  await fs.writeFile(filePath, content, 'utf8');
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

function createGatewayAuth() {
  return {
    mode: 'token',
    token: crypto.randomBytes(24).toString('hex'),
  };
}

/**
 * 以 subprocess 方式运行 openclaw agent
 * OPENCLAW_STATE_DIR 指向该用户的独立临时目录
 */
function runOpenClaw(message, stateDir, env, userId) {
  return new Promise((resolve, reject) => {
    const args = [
      'agent',
      '--local',
      '--session-key', String(userId),
      '--message', message,
      '--json',
    ];

    const proc = execFile('openclaw', args, {
      env: {
        ...env,
        OPENCLAW_HOME:          stateDir,
        OPENCLAW_STATE_DIR:     path.join(stateDir, '.openclaw'),
        OPENCLAW_CONFIG_PATH:   path.join(stateDir, '.openclaw', 'openclaw.json'),
        OPENCLAW_WORKSPACE_DIR: path.join(stateDir, 'workspace'),
      },
      cwd: path.join(stateDir, 'workspace'),
      timeout: 55000, // 55s，Cloud Run 默认 60s 超时
    }, (err, stdout, stderr) => {
      if (err) {
        if (stdout?.trim()) console.error('[openclaw stdout]', stdout);
        console.error('[openclaw stderr]', stderr);
        reject(new Error(stderr?.trim() || err.message));
      } else {
        resolve(parseOpenClawReply(stdout));
      }
    });

    proc.on('error', reject);
  });
}

function parseOpenClawReply(stdout) {
  const clean = stripAnsi(stdout).trim();
  if (!clean) return '';

  const parsed = parseJsonFromOutput(clean);
  const text = extractPayloadText(parsed);
  if (text) return text;

  return clean
    .split(/\r?\n/)
    .filter((line) => !isInternalOpenClawLine(line))
    .join('\n')
    .trim();
}

function parseJsonFromOutput(output) {
  try {
    return JSON.parse(output);
  } catch {
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line.startsWith('{') || !line.endsWith('}')) continue;
      try {
        return JSON.parse(line);
      } catch {
        // keep scanning older lines
      }
    }

    const firstBrace = output.indexOf('{');
    const lastBrace = output.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;
    try {
      return JSON.parse(output.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
}

function extractPayloadText(parsed) {
  const payloads = Array.isArray(parsed?.payloads)
    ? parsed.payloads
    : parsed?.result?.payloads;

  if (!Array.isArray(payloads)) {
    return '';
  }

  return payloads
    .map((payload) => payload?.text)
    .filter((item) => typeof item === 'string' && item.trim())
    .join('\n\n')
    .trim();
}

function isInternalOpenClawLine(line) {
  return /^\s*\[(?:agents\/tool-policy|diagnostic|model-fallback\/decision|tool-policy)\]/i.test(line);
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ openclaw-agent (real) 运行中 → port ${PORT}`));
