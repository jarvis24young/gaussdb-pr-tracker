import express from 'express';
import 'dotenv/config';
import { Anthropic } from '@anthropic-ai/sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  readFileSync, writeFileSync, existsSync,
  mkdirSync, readdirSync
} from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const DATA_DIR = join(__dirname, 'data');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ─── Settings ───────────────────────────────────────────────────────────────

function normalizeAiProvider(provider) {
  return provider === 'minimax' ? 'minimax' : 'anthropic';
}

function defaultAiProvider() {
  const provider = (process.env.AI_PROVIDER || '').toLowerCase();
  if (provider === 'anthropic' || provider === 'minimax') return provider;
  return process.env.MINIMAX_API_KEY ? 'minimax' : 'anthropic';
}

function loadSettings() {
  let saved = {};
  if (existsSync(SETTINGS_FILE)) {
    try { saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  }
  const settings = {
    // Defaults from env vars; saved settings win
    gaussdbOdbcPath:  process.env.GAUSSDB_ODBC_PATH || '',
    aiProvider:       defaultAiProvider(),
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL  || '',
    anthropicApiKey:  process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '',
    anthropicModel:   process.env.ANTHROPIC_MODEL || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4.6',
    minimaxApiKey:    process.env.MINIMAX_API_KEY || '',
    minimaxModel:     process.env.MINIMAX_MODEL || 'MiniMax-Text-01',
    minimaxBaseUrl:   process.env.MINIMAX_BASE_URL || 'https://api.minimax.chat/v1',
    githubToken:      process.env.GITHUB_TOKEN || '',
    proxy:            process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
    ...saved,
  };
  settings.aiProvider = normalizeAiProvider(settings.aiProvider);
  return settings;
}

function saveSettings(patch) {
  let current = {};
  if (existsSync(SETTINGS_FILE)) {
    try { current = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  }
  const next = { ...current, ...patch };
  if (next.aiProvider) next.aiProvider = normalizeAiProvider(next.aiProvider);
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
}

function isConfigured(s) {
  if (!s.gaussdbOdbcPath) return false;
  if (s.aiProvider === 'minimax') return !!s.minimaxApiKey;
  return !!s.anthropicApiKey;
}

app.get('/api/settings', (req, res) => {
  const s = loadSettings();
  res.json({
    gaussdbOdbcPath:  s.gaussdbOdbcPath  || '',
    aiProvider:       s.aiProvider,
    anthropicBaseUrl: s.anthropicBaseUrl || '',
    anthropicModel:   s.anthropicModel   || 'claude-sonnet-4.6',
    minimaxModel:     s.minimaxModel     || 'MiniMax-Text-01',
    minimaxBaseUrl:   s.minimaxBaseUrl   || 'https://api.minimax.chat/v1',
    proxy:            s.proxy            || '',
    hasAnthropicKey:  !!s.anthropicApiKey,
    hasMinimaxKey:    !!s.minimaxApiKey,
    hasGithubToken:   !!s.githubToken,
    configured:       isConfigured(s),
  });
});

app.post('/api/settings', (req, res) => {
  const allowed = [
    'gaussdbOdbcPath', 'aiProvider',
    'anthropicApiKey', 'anthropicBaseUrl', 'anthropicModel',
    'minimaxApiKey', 'minimaxModel', 'minimaxBaseUrl',
    'githubToken', 'proxy',
  ];
  const patch = {};
  for (const key of allowed) {
    const val = req.body[key];
    // Only overwrite if value was explicitly sent and non-empty (except paths which can be empty string)
    if (val !== undefined && (val !== '' || ['gaussdbOdbcPath','anthropicBaseUrl','proxy','minimaxBaseUrl'].includes(key))) {
      patch[key] = val;
    }
  }
  saveSettings(patch);
  res.json({ ok: true });
});

// ─── AI abstraction layer ───────────────────────────────────────────────────

async function callAI(prompt) {
  const s = loadSettings();
  if (s.aiProvider === 'minimax') return callMiniMax(prompt, s);
  return callAnthropic(prompt, s);
}

async function callAnthropic(prompt, s) {
  if (!s.anthropicApiKey) throw new Error('Anthropic API Key 未配置');
  const opts = { apiKey: s.anthropicApiKey };
  if (s.anthropicBaseUrl) opts.baseURL = s.anthropicBaseUrl;
  if (s.proxy) opts.httpAgent = new HttpsProxyAgent(s.proxy);
  const client = new Anthropic(opts);
  const msg = await client.messages.create({
    model: s.anthropicModel || 'claude-sonnet-4.6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content[0].text;
}

async function callMiniMax(prompt, s) {
  if (!s.minimaxApiKey) throw new Error('MiniMax API Key 未配置');
  const baseUrl = (s.minimaxBaseUrl || 'https://api.minimax.chat/v1').replace(/\/$/, '');
  const model   = s.minimaxModel || 'MiniMax-Text-01';

  const fetchOpts = {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${s.minimaxApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
    }),
  };
  if (s.proxy) fetchOpts.agent = new HttpsProxyAgent(s.proxy);

  const r    = await fetch(`${baseUrl}/chat/completions`, fetchOpts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `MiniMax API ${r.status}`);
  const content = data.choices?.[0]?.message?.content || data.choices?.[0]?.text;
  if (!content) throw new Error('MiniMax API 返回内容为空');
  return content;
}

// ─── GitHub helpers ─────────────────────────────────────────────────────────

function githubHeaders() {
  const s = loadSettings();
  const h = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'gaussdb-pr-tracker' };
  if (s.githubToken) h['Authorization'] = `token ${s.githubToken}`;
  return h;
}

async function githubFetch(url) {
  const s = loadSettings();
  const opts = { headers: githubHeaders() };
  if (s.proxy) opts.agent = new HttpsProxyAgent(s.proxy);
  return fetch(url, opts);
}

// ─── PR List ────────────────────────────────────────────────────────────────

app.get('/api/prs', async (req, res) => {
  const cacheFile = join(DATA_DIR, 'prs.json');
  if (existsSync(cacheFile) && !req.query.refresh) {
    return res.json(JSON.parse(readFileSync(cacheFile, 'utf8')));
  }
  try {
    const pages = Math.max(1, Math.min(parseInt(process.env.GITHUB_PR_PAGES || '3', 10) || 3, 10));
    const merged = [];
    for (let page = 1; page <= pages; page++) {
      const r = await githubFetch(
        `https://api.github.com/repos/postgresql-interfaces/psqlodbc/pulls?state=closed&per_page=100&sort=updated&direction=desc&page=${page}`
      );
      const data = await r.json();
      if (!Array.isArray(data)) return res.status(502).json({ error: data.message || 'GitHub API error' });
      merged.push(...data.filter(pr => pr.merged_at));
      if (data.length < 100) break;
    }
    writeFileSync(cacheFile, JSON.stringify(merged, null, 2));
    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Local code search ──────────────────────────────────────────────────────

function findFileInDir(dir, filename, depth = 0) {
  if (depth > 4) return null;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.isFile() && e.name === filename) return join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = findFileInDir(join(dir, e.name), filename, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function findGaussDBFile(upstreamFilename) {
  const s = loadSettings();
  if (!s.gaussdbOdbcPath) return null;
  const fname = basename(upstreamFilename);
  const found = findFileInDir(s.gaussdbOdbcPath, fname);
  if (!found) return null;
  return { path: found, content: readFileSync(found, 'utf8') };
}

// ─── Analyze ────────────────────────────────────────────────────────────────

app.post('/api/analyze/:prNumber', async (req, res) => {
  const { prNumber } = req.params;
  const cacheFile = join(DATA_DIR, `analysis_${prNumber}.json`);
  if (existsSync(cacheFile) && !req.query.force) {
    return res.json(JSON.parse(readFileSync(cacheFile, 'utf8')));
  }

  try {
    const [prRes, filesRes] = await Promise.all([
      githubFetch(`https://api.github.com/repos/postgresql-interfaces/psqlodbc/pulls/${prNumber}`),
      githubFetch(`https://api.github.com/repos/postgresql-interfaces/psqlodbc/pulls/${prNumber}/files`),
    ]);
    const pr    = await prRes.json();
    const files = await filesRes.json();
    if (!Array.isArray(files)) throw new Error('无法获取 PR 文件列表');

    const srcFiles     = files.filter(f => /\.(c|h)$/.test(f.filename)).slice(0, 6);
    const fileContexts = srcFiles.map(f => {
      const local = findGaussDBFile(f.filename);
      return {
        upstreamFile:   f.filename,
        patch:          (f.patch || '').slice(0, 2500),
        gaussdbPath:    local?.path || null,
        gaussdbSnippet: local ? extractRelevantSnippet(local.content, f.patch) : null,
      };
    });

    if (fileContexts.length === 0) {
      const result = buildResult(prNumber, pr, files, [], {
        summary: '此 PR 未修改 C/H 源文件，与驱动逻辑无关',
        bugType: '其他', riskLevel: 'NOT_APPLICABLE',
        riskReason: '变更仅涉及构建脚本/文档/测试等非驱动核心代码',
        affectedFiles: [], recommendation: '无需处理', hasCorrespondingCode: false,
      });
      writeFileSync(cacheFile, JSON.stringify(result, null, 2));
      return res.json(result);
    }

    const rawText = await callAI(buildPrompt(pr, prNumber, fileContexts));

    let analysis;
    try {
      const m = rawText.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(m[0]);
    } catch {
      analysis = {
        summary: rawText.slice(0, 200),
        bugType: '其他', riskLevel: 'UNKNOWN',
        riskReason: 'AI 输出解析失败，请重新分析',
        affectedFiles: [], recommendation: '', hasCorrespondingCode: false,
      };
    }

    const result = buildResult(prNumber, pr, files, fileContexts, analysis);
    writeFileSync(cacheFile, JSON.stringify(result, null, 2));
    res.json(result);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── All analyses ────────────────────────────────────────────────────────────

app.get('/api/analyses', (req, res) => {
  const results = [];
  readdirSync(DATA_DIR)
    .filter(f => f.startsWith('analysis_') && f.endsWith('.json'))
    .forEach(f => {
      try { results.push(JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'))); } catch {}
    });
  res.json(results.sort((a, b) => new Date(b.analyzedAt) - new Date(a.analyzedAt)));
});

// ─── Debug ──────────────────────────────────────────────────────────────────

app.get('/api/debug', (req, res) => {
  const s = loadSettings();
  res.json({
    aiProvider:      s.aiProvider,
    model:           s.aiProvider === 'minimax' ? s.minimaxModel : s.anthropicModel,
    baseUrl:         s.aiProvider === 'minimax' ? s.minimaxBaseUrl : (s.anthropicBaseUrl || 'https://api.anthropic.com'),
    proxy:           s.proxy || '(无)',
    hasKey:          s.aiProvider === 'minimax' ? !!s.minimaxApiKey : !!s.anthropicApiKey,
    gaussdbOdbcPath: s.gaussdbOdbcPath || '(未设置)',
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractRelevantSnippet(fileContent, patch) {
  if (!patch || !fileContent) return fileContent?.slice(0, 4000) || null;
  const funcMatches = patch.match(/\b(\w+)\s*\(/g) || [];
  const funcNames   = [...new Set(funcMatches.map(m => m.replace(/\s*\($/, '')))].slice(0, 5);
  const lines       = fileContent.split('\n');
  const relevant    = new Set();
  lines.forEach((line, i) => {
    if (funcNames.some(fn => line.includes(fn))) {
      for (let j = Math.max(0, i - 2); j < Math.min(lines.length, i + 60); j++) relevant.add(j);
    }
  });
  const snippet = relevant.size > 10
    ? [...relevant].sort((a, b) => a - b).map(i => lines[i]).join('\n')
    : fileContent.slice(0, 4000);
  return snippet.slice(0, 4000);
}

function buildPrompt(pr, prNumber, fileContexts) {
  return `你是资深数据库驱动开发工程师，熟悉 psqlodbc 与 GaussDB ODBC 驱动代码。

## 任务
分析 psqlodbc 社区 PR #${prNumber}，判断 GaussDB ODBC 是否存在相同或相似问题。

## PR 信息
- 标题：${pr.title}
- 描述：${(pr.body || '无描述').slice(0, 600)}

## 变更文件分析
${fileContexts.map(f => `
### 上游文件：${f.upstreamFile}
**社区修复 diff：**
\`\`\`diff
${f.patch}
\`\`\`

${f.gaussdbSnippet
  ? `**GaussDB 对应代码（${f.gaussdbPath}）：**\n\`\`\`c\n${f.gaussdbSnippet}\n\`\`\``
  : `**GaussDB 中未找到文件 ${f.upstreamFile}**`
}
`).join('\n---\n')}

## 输出（严格 JSON，不含其他内容）
{
  "summary": "一句话：这个PR修复了什么",
  "bugType": "内存泄漏/空指针/缓冲区溢出/逻辑错误/资源泄漏/其他",
  "riskLevel": "HIGH/MEDIUM/LOW/NOT_APPLICABLE",
  "riskReason": "2-3句具体说明：GaussDB代码中是否有相同模式，引用具体函数名或变量名",
  "affectedFiles": ["GaussDB受影响文件路径（如已找到）"],
  "recommendation": "具体修复建议，如：检查xx.c第N行的Y函数是否处理了Z边界条件",
  "hasCorrespondingCode": true或false
}`;
}

function buildResult(prNumber, pr, files, fileContexts, analysis) {
  return {
    prNumber:     parseInt(prNumber),
    prTitle:      pr.title,
    prUrl:        pr.html_url,
    mergedAt:     pr.merged_at,
    analyzedAt:   new Date().toISOString(),
    changedFiles: files.map(f => f.filename),
    matchedFiles: fileContexts.filter(f => f.gaussdbPath).map(f => ({
      upstream: f.upstreamFile,
      local:    f.gaussdbPath,
    })),
    ...analysis,
  };
}

const PORT = parseInt(process.env.PORT || '3000', 10);

app.listen(PORT, () => {
  const s = loadSettings();
  const provider = s.aiProvider || 'anthropic';
  console.log(`GaussDB PR Tracker → http://localhost:${PORT}`);
  console.log(`  Provider : ${provider.toUpperCase()}`);
  console.log(`  Model    : ${provider === 'minimax' ? s.minimaxModel : s.anthropicModel}`);
  console.log(`  Base URL : ${provider === 'minimax' ? s.minimaxBaseUrl : (s.anthropicBaseUrl || 'https://api.anthropic.com')}`);
  console.log(`  Proxy    : ${s.proxy || '(无)'}`);
  console.log(`  ODBC Path: ${s.gaussdbOdbcPath || '(未配置)'}`);
});
