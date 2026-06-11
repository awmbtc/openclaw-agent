// GCS 用户状态管理 — 每用户独立的 openclaw 状态目录
const { Storage } = require('@google-cloud/storage');
const fs   = require('fs/promises');
const path = require('path');

const storage = new Storage();
const BUCKET  = process.env.GCS_BUCKET || 'openclaw-userdata';

/**
 * 从 GCS 恢复用户状态到本地临时目录
 * 新用户：GCS 无文件，直接返回（openclaw 会自动初始化）
 */
async function restoreState(userId, localDir) {
  try {
    const [files] = await storage.bucket(BUCKET).getFiles({ prefix: `${userId}/` });
    await Promise.all(files.map(async (file) => {
      const rel   = file.name.slice(`${userId}/`.length);
      if (!rel) return;
      const dest  = path.join(localDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await file.download({ destination: dest });
    }));
    console.log(`[state] 恢复 ${files.length} 个文件 for user ${userId}`);
  } catch (err) {
    console.log(`[state] 新用户或恢复失败（正常）: ${err.message}`);
  }
}

/**
 * 把本地临时目录上传回 GCS
 * 跳过 .env（API Key 不持久化）
 */
async function saveState(userId, localDir) {
  const files = await walkDir(localDir);
  await Promise.all(files.map(async (localPath) => {
    const rel = path.relative(localDir, localPath);
    if (rel.includes('.env')) return; // 不存 API Key
    if (rel === path.join('.openclaw', 'openclaw.json')) return; // 运行时配置每次重建，不持久化临时 gateway 凭据
    const gcsPath = `${userId}/${rel}`;
    await storage.bucket(BUCKET).upload(localPath, { destination: gcsPath });
  }));
  console.log(`[state] 保存 ${files.length} 个文件 for user ${userId}`);
}

async function walkDir(dir) {
  let results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(await walkDir(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

module.exports = { restoreState, saveState };
