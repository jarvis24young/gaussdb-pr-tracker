import express from 'express';
import 'dotenv/config';
import { Anthropic } from '@anthropic-ai/sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  readFileSync, writeFileSync, existsSync,
  mkdirSync, readdirSync, statSync
} from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const DATA_DIR = join(__dirname, 'data');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const ANALYSIS_PROMPT_VERSION = 8;
const ANALYSIS_METHOD = 'SOURCE_CONFIRMED_DRIVER_SYNC';
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const DRIVER_PROFILES = {
  odbc: {
    id: 'odbc',
    name: 'GaussDB ODBC',
    shortName: 'ODBC',
    upstreamRepo: 'postgresql-interfaces/psqlodbc',
    upstreamLabel: 'psqlodbc 社区',
    upstreamPathPrefix: '',
    localPathKey: 'gaussdbOdbcPath',
    envPathKey: 'GAUSSDB_ODBC_PATH',
    localPathLabel: '本地 GaussDB ODBC 代码路径',
    localPathPlaceholder: '例：D:/GaussDB/openGauss-connector-odbc',
    sourceFilePattern: /\.(c|h)$/i,
    codeFence: 'c',
    maxSearchDepth: 5,
    promptExpert: '熟悉 psqlodbc 与 GaussDB ODBC 驱动代码',
    promptTarget: '本地 GaussDB ODBC 仓库',
  },
  jdbc: {
    id: 'jdbc',
    name: 'GaussDB JDBC',
    shortName: 'JDBC',
    upstreamRepo: 'pgjdbc/pgjdbc',
    upstreamLabel: 'pgjdbc 社区',
    upstreamPathPrefix: '',
    localPathKey: 'gaussdbJdbcPath',
    envPathKey: 'GAUSSDB_JDBC_PATH',
    localPathLabel: '本地 GaussDB JDBC 代码路径',
    localPathPlaceholder: '例：D:/GaussDB/openGauss-connector-jdbc',
    sourceFilePattern: /\.(java|kt|kts|gradle|xml|properties)$/i,
    codeFence: 'java',
    maxSearchDepth: 9,
    promptExpert: '熟悉 pgjdbc 与 GaussDB JDBC 驱动代码',
    promptTarget: '本地 GaussDB JDBC 仓库',
  },
};

function normalizeProfileId(profileId) {
  const id = String(profileId || '').toLowerCase();
  return DRIVER_PROFILES[id] ? id : 'odbc';
}

function getProfile(profileId) {
  return DRIVER_PROFILES[normalizeProfileId(profileId)];
}

function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    shortName: profile.shortName,
    upstreamRepo: profile.upstreamRepo,
    upstreamLabel: profile.upstreamLabel,
    upstreamPathPrefix: profile.upstreamPathPrefix,
    localPathKey: profile.localPathKey,
    localPathLabel: profile.localPathLabel,
    localPathPlaceholder: profile.localPathPlaceholder,
  };
}

function allPublicProfiles() {
  return Object.values(DRIVER_PROFILES).map(publicProfile);
}

// ─── Settings ───────────────────────────────────────────────────────────────

function normalizeAiProvider(provider) {
  return provider === 'minimax' ? 'minimax' : 'anthropic';
}

function defaultAiProvider() {
  const provider = (process.env.AI_PROVIDER || '').toLowerCase();
  if (provider === 'anthropic' || provider === 'minimax') return provider;
  return process.env.MINIMAX_API_KEY ? 'minimax' : 'anthropic';
}

const CLAUDE_ENV_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
];

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function addClaudeEnv(env, key, value) {
  if (CLAUDE_ENV_KEYS.includes(key) && typeof value === 'string' && value.trim() && !env[key]) {
    env[key] = value.trim();
  }
}

function mergeClaudeEnv(target, source) {
  for (const [key, value] of Object.entries(source)) addClaudeEnv(target, key, value);
}

function extractClaudeEnv(value, depth = 0) {
  const env = {};
  if (!value || depth > 4) return env;

  if (Array.isArray(value)) {
    for (const item of value) mergeClaudeEnv(env, extractClaudeEnv(item, depth + 1));
    return env;
  }

  if (typeof value !== 'object') return env;

  for (const key of CLAUDE_ENV_KEYS) addClaudeEnv(env, key, value[key]);

  if (value.env && typeof value.env === 'object') {
    mergeClaudeEnv(env, extractClaudeEnv(value.env, depth + 1));
  }

  if (Array.isArray(value.conflicts)) {
    for (const item of value.conflicts) addClaudeEnv(env, item.varName, item.varValue);
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key === 'env' || key === 'conflicts') continue;
    if (nested && typeof nested === 'object') mergeClaudeEnv(env, extractClaudeEnv(nested, depth + 1));
  }

  return env;
}

function claudeSettingsFromEnv(env) {
  const anthropicApiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || '';
  const anthropicModel = env.ANTHROPIC_MODEL
    || env.ANTHROPIC_DEFAULT_SONNET_MODEL
    || env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    || env.ANTHROPIC_DEFAULT_OPUS_MODEL
    || '';
  if (!anthropicApiKey && !env.ANTHROPIC_BASE_URL && !anthropicModel) return null;

  return {
    aiProvider: 'anthropic',
    anthropicApiKey,
    anthropicBaseUrl: env.ANTHROPIC_BASE_URL || '',
    anthropicModel,
    proxy: env.HTTPS_PROXY || env.HTTP_PROXY || '',
  };
}

function readJsonConfig(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function addFileCandidate(candidates, path, sourceType) {
  if (!path || !existsSync(path)) return;
  try {
    if (!statSync(path).isFile()) return;
  } catch {
    return;
  }
  candidates.push({ path, sourceType });
}

function claudeConfigCandidates() {
  const candidates = [];
  const home = homedir();

  addFileCandidate(candidates, process.env.CLAUDE_CONFIG_PATH, 'custom');
  addFileCandidate(candidates, join(home, '.claude', 'settings.json'), 'claude-code');
  addFileCandidate(candidates, join(home, '.claude.json'), 'claude-code');
  addFileCandidate(candidates, join(process.env.APPDATA || '', 'Claude', 'settings.json'), 'claude-code');
  addFileCandidate(candidates, join(process.env.LOCALAPPDATA || '', 'claude-cli-nodejs', 'settings.json'), 'claude-code');

  const backupDir = join(home, '.cc-switch', 'backups');
  try {
    readdirSync(backupDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^env-backup-.*\.json$/i.test(entry.name))
      .map(entry => join(backupDir, entry.name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .forEach(path => addFileCandidate(candidates, path, 'cc-switch-backup'));
  } catch {}

  return candidates;
}

function findClaudeCodeConfigs({ includeProcessEnv = true } = {}) {
  const configs = [];

  if (includeProcessEnv) {
    const settings = claudeSettingsFromEnv(process.env);
    if (settings) configs.push({ sourcePath: 'process.env', sourceType: 'environment', settings });
  }

  for (const candidate of claudeConfigCandidates()) {
    const json = readJsonConfig(candidate.path);
    if (!json) continue;

    const env = extractClaudeEnv(json);
    const settings = claudeSettingsFromEnv(env);
    if (!settings) continue;

    configs.push({
      sourcePath: candidate.path,
      sourceType: candidate.sourceType,
      settings,
    });
  }

  const seen = new Set();
  return configs
    .filter(config => {
      const key = [
        config.settings.anthropicApiKey,
        config.settings.anthropicBaseUrl,
        config.settings.anthropicModel,
        config.sourcePath,
      ].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((config, index) => ({ ...config, id: String(index) }));
}

function publicClaudeConfig(config) {
  return {
    id: config.id,
    sourcePath: config.sourcePath,
    sourceType: config.sourceType,
    aiProvider: config.settings.aiProvider,
    anthropicBaseUrl: config.settings.anthropicBaseUrl,
    anthropicModel: config.settings.anthropicModel,
    hasAnthropicKey: !!config.settings.anthropicApiKey,
    tokenPreview: maskSecret(config.settings.anthropicApiKey),
    hasProxy: !!config.settings.proxy,
  };
}

function loadClaudeCodeDefaults() {
  const config = findClaudeCodeConfigs({ includeProcessEnv: false })[0];
  return config?.settings || {};
}

function loadSettings() {
  let saved = {};
  if (existsSync(SETTINGS_FILE)) {
    try { saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  }
  const claudeDefaults = loadClaudeCodeDefaults();
  const settings = {
    // Defaults from env vars; saved settings win
    driverProfile:    process.env.GAUSSDB_DRIVER_PROFILE || process.env.DRIVER_PROFILE || 'odbc',
    gaussdbOdbcPath:  process.env.GAUSSDB_ODBC_PATH || '',
    gaussdbJdbcPath:  process.env.GAUSSDB_JDBC_PATH || '',
    aiProvider:       defaultAiProvider(),
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || claudeDefaults.anthropicBaseUrl || '',
    anthropicApiKey:  process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || claudeDefaults.anthropicApiKey || '',
    anthropicModel:   process.env.ANTHROPIC_MODEL || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || claudeDefaults.anthropicModel || 'claude-sonnet-4.6',
    minimaxApiKey:    process.env.MINIMAX_API_KEY || '',
    minimaxModel:     process.env.MINIMAX_MODEL || 'MiniMax-Text-01',
    minimaxBaseUrl:   process.env.MINIMAX_BASE_URL || 'https://api.minimax.chat/v1',
    githubToken:      process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_AUTH_TOKEN || '',
    proxy:            process.env.HTTPS_PROXY || process.env.HTTP_PROXY || claudeDefaults.proxy || '',
    ...saved,
  };
  settings.driverProfile = normalizeProfileId(settings.driverProfile);
  settings.aiProvider = normalizeAiProvider(settings.aiProvider);
  return settings;
}

function saveSettings(patch) {
  let current = {};
  if (existsSync(SETTINGS_FILE)) {
    try { current = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  }
  const next = { ...current, ...patch };
  if (next.driverProfile) next.driverProfile = normalizeProfileId(next.driverProfile);
  if (next.aiProvider) next.aiProvider = normalizeAiProvider(next.aiProvider);
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
}

function localPathForProfile(settings, profile = getProfile(settings.driverProfile)) {
  return settings[profile.localPathKey] || '';
}

function isConfigured(s) {
  if (!localPathForProfile(s)) return false;
  if (s.aiProvider === 'minimax') return !!s.minimaxApiKey;
  return !!s.anthropicApiKey;
}

app.get('/api/settings', (req, res) => {
  const s = loadSettings();
  res.json({
    profiles:         allPublicProfiles(),
    driverProfile:    s.driverProfile,
    gaussdbOdbcPath:  s.gaussdbOdbcPath  || '',
    gaussdbJdbcPath:  s.gaussdbJdbcPath  || '',
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
    'driverProfile', 'gaussdbOdbcPath', 'gaussdbJdbcPath', 'aiProvider',
    'anthropicApiKey', 'anthropicBaseUrl', 'anthropicModel',
    'minimaxApiKey', 'minimaxModel', 'minimaxBaseUrl',
    'githubToken', 'proxy',
  ];
  const patch = {};
  for (const key of allowed) {
    const val = req.body[key];
    // Only overwrite if value was explicitly sent and non-empty (except paths which can be empty string)
    if (val !== undefined && (val !== '' || [
      'gaussdbOdbcPath', 'gaussdbJdbcPath',
      'anthropicBaseUrl', 'proxy', 'minimaxBaseUrl',
    ].includes(key))) {
      patch[key] = val;
    }
  }
  saveSettings(patch);
  res.json({ ok: true });
});

app.get('/api/claude-code-configs', (req, res) => {
  const configs = findClaudeCodeConfigs().map(publicClaudeConfig);
  res.json({ configs });
});

app.post('/api/import-claude-code-config', (req, res) => {
  const configs = findClaudeCodeConfigs();
  const config = configs.find(item => item.id === String(req.body.id ?? '0'));
  if (!config) return res.status(404).json({ error: '未找到可导入的 ClaudeCode 配置' });

  const patch = {
    aiProvider: 'anthropic',
    anthropicApiKey: config.settings.anthropicApiKey,
    anthropicBaseUrl: config.settings.anthropicBaseUrl || '',
    anthropicModel: config.settings.anthropicModel || 'claude-sonnet-4.6',
  };
  if (config.settings.proxy) patch.proxy = config.settings.proxy;

  saveSettings(patch);
  res.json({
    ok: true,
    config: publicClaudeConfig(config),
    settingsPath: SETTINGS_FILE,
  });
});

// ─── AI abstraction layer ───────────────────────────────────────────────────

const AI_MAX_CONCURRENCY = Math.max(1, Math.min(parseInt(process.env.AI_MAX_CONCURRENCY || '1', 10) || 1, 4));
const AI_RETRY_ATTEMPTS = Math.max(1, Math.min(parseInt(process.env.AI_RETRY_ATTEMPTS || '3', 10) || 3, 5));
let activeAiCalls = 0;
const aiQueue = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function releaseAiSlot() {
  activeAiCalls = Math.max(0, activeAiCalls - 1);
  const next = aiQueue.shift();
  if (next) next();
}

async function runInAiQueue(task) {
  if (activeAiCalls >= AI_MAX_CONCURRENCY) {
    await new Promise(resolve => aiQueue.push(resolve));
  }
  activeAiCalls += 1;
  try {
    return await task();
  } finally {
    releaseAiSlot();
  }
}

function aiErrorMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  const parts = [
    err.message,
    err.status ? `status=${err.status}` : '',
    err.code ? `code=${err.code}` : '',
    err.type ? `type=${err.type}` : '',
  ].filter(Boolean);
  return parts.join(' ');
}

function isAiRateLimitError(err) {
  const msg = aiErrorMessage(err).toLowerCase();
  return /(^|\D)429(\D|$)/.test(msg)
    || msg.includes('concurrency')
    || msg.includes('rate limit')
    || msg.includes('too many requests');
}

async function callAI(prompt) {
  return runInAiQueue(() => callAIWithRetry(prompt));
}

async function callAIWithRetry(prompt) {
  let lastErr;
  for (let attempt = 1; attempt <= AI_RETRY_ATTEMPTS; attempt++) {
    try {
      return await callAIOnce(prompt);
    } catch (err) {
      lastErr = err;
      if (!isAiRateLimitError(err) || attempt === AI_RETRY_ATTEMPTS) break;
      const delayMs = Math.min(20000, 1500 * attempt * attempt);
      console.warn(`AI rate/concurrency limit hit, retrying in ${delayMs}ms (${attempt}/${AI_RETRY_ATTEMPTS})`);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

async function callAIOnce(prompt) {
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
    max_tokens: 4096,
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
      max_tokens: 4096,
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
  if (s.githubToken) h['Authorization'] = `Bearer ${s.githubToken}`;
  return h;
}

async function githubFetch(url) {
  const s = loadSettings();
  const opts = { headers: githubHeaders() };
  if (s.proxy) opts.agent = new HttpsProxyAgent(s.proxy);
  return fetch(url, opts);
}

function profileFromRequest(req) {
  return getProfile(req.query.profile || req.body?.profile || loadSettings().driverProfile);
}

function dataFileForProfile(profile, name) {
  return join(DATA_DIR, `${profile.id}_${name}`);
}

// ─── PR List ────────────────────────────────────────────────────────────────

app.get('/api/prs', async (req, res) => {
  const profile = profileFromRequest(req);
  const cacheFile = dataFileForProfile(profile, 'prs.json');
  if (existsSync(cacheFile) && !req.query.refresh) {
    return res.json(JSON.parse(readFileSync(cacheFile, 'utf8')));
  }
  try {
    const pages = Math.max(1, Math.min(parseInt(process.env.GITHUB_PR_PAGES || '3', 10) || 3, 10));
    const merged = [];
    for (let page = 1; page <= pages; page++) {
      const r = await githubFetch(
        `https://api.github.com/repos/${profile.upstreamRepo}/pulls?state=closed&per_page=100&sort=updated&direction=desc&page=${page}`
      );
      const data = await r.json();
      if (!Array.isArray(data)) return res.status(502).json({ error: data.message || 'GitHub API error' });
      merged.push(...data.filter(pr => pr.merged_at).map(pr => ({ ...pr, trackerProfile: profile.id })));
      if (data.length < 100) break;
    }
    writeFileSync(cacheFile, JSON.stringify(merged, null, 2));
    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Local code search ──────────────────────────────────────────────────────

const SKIP_LOCAL_DIRS = new Set([
  '.git', '.idea', '.vscode', 'node_modules', 'target', 'build', '.gradle',
  'out', 'dist', 'coverage', '.mvn', 'test', 'tests', 'testing',
  'example', 'examples', 'doc', 'docs', 'ci',
]);

const COMMON_CALL_IGNORES = new Set([
  'if', 'for', 'while', 'switch', 'return', 'sizeof', 'case', 'catch',
  'new', 'throw', 'typeof', 'defined',
  'printf', 'fprintf', 'snprintf', 'sprintf', 'sscanf', 'scanf',
  'strlen', 'strcmp', 'strncmp', 'strcpy', 'strncpy', 'strcat', 'strncat',
  'memcpy', 'memmove', 'memset', 'malloc', 'calloc', 'realloc', 'free',
  'assert', 'sizeof', 'String', 'Integer', 'Long', 'Boolean', 'Objects',
]);

function basenameCandidates(upstreamFilename, profile) {
  const fname = basename(upstreamFilename);
  const names = new Set([fname]);
  return [...names];
}

function localRelativeCandidates(upstreamFilename, profile) {
  const candidates = [];
  if (profile.upstreamPathPrefix && upstreamFilename.startsWith(profile.upstreamPathPrefix)) {
    const rel = upstreamFilename.slice(profile.upstreamPathPrefix.length);
    candidates.push(rel);
  }
  return candidates;
}

function findFileInDir(dir, filenames, depth = 0, maxDepth = 5) {
  if (depth > maxDepth) return null;
  const wanted = new Set(Array.isArray(filenames) ? filenames : [filenames]);
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.isFile() && wanted.has(e.name)) return join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_LOCAL_DIRS.has(e.name)) {
      const found = findFileInDir(join(dir, e.name), filenames, depth + 1, maxDepth);
      if (found) return found;
    }
  }
  return null;
}

function findGaussDBFile(upstreamFilename, profile) {
  const s = loadSettings();
  const localRoot = localPathForProfile(s, profile);
  if (!localRoot) return null;

  for (const rel of localRelativeCandidates(upstreamFilename, profile)) {
    const direct = join(localRoot, rel);
    if (existsSync(direct)) return { path: direct, content: readFileSync(direct, 'utf8') };
  }

  const found = findFileInDir(localRoot, basenameCandidates(upstreamFilename, profile), 0, profile.maxSearchDepth);
  if (!found) return null;
  return { path: found, content: readFileSync(found, 'utf8') };
}

function isSourceFileForProfile(filename, profile) {
  if (profile.upstreamPathPrefix && !filename.startsWith(profile.upstreamPathPrefix)) return false;
  if (isTestOrExampleFile(filename)) return false;
  return profile.sourceFilePattern.test(filename);
}

function isTestOrExampleFile(filename) {
  const normalized = String(filename || '').replace(/\\/g, '/');
  if (/(^|\/)(test|tests|testing|example|examples|docs?|ci)(\/|$)/i.test(normalized)) return true;

  const base = basename(normalized);
  return /(^test[_-]|[_-]test$|\.test$|^spec[_-]|[_-]spec$|\.spec$)/i
    .test(base.replace(/\.(c|h|cpp|cc|java|kt|kts|xml|properties|gradle)$/i, ''));
}

// ─── Analyze ────────────────────────────────────────────────────────────────

app.post('/api/analyze/:prNumber', async (req, res) => {
  const { prNumber } = req.params;
  const profile = profileFromRequest(req);
  const cacheFile = dataFileForProfile(profile, `analysis_${prNumber}.json`);
  if (existsSync(cacheFile) && !req.query.force) {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (cached.analysisPromptVersion === ANALYSIS_PROMPT_VERSION) return res.json(cached);
  }

  try {
    const [prRes, filesRes] = await Promise.all([
      githubFetch(`https://api.github.com/repos/${profile.upstreamRepo}/pulls/${prNumber}`),
      githubFetch(`https://api.github.com/repos/${profile.upstreamRepo}/pulls/${prNumber}/files`),
    ]);
    const pr    = await prRes.json();
    const files = await filesRes.json();
    if (!Array.isArray(files)) throw new Error('无法获取 PR 文件列表');

    const srcFiles     = files.filter(f => isSourceFileForProfile(f.filename, profile)).slice(0, 8);
    const fileContexts = srcFiles.map(f => {
      const local = findGaussDBFile(f.filename, profile);
      const patchInfo = parsePatch(f.patch || '');
      const localSignals = local ? buildLocalPatchSignals(local.content, patchInfo) : null;
      return {
        upstreamFile:   f.filename,
        patch:          (f.patch || '').slice(0, 4500),
        patchInfo,
        localSignals,
        gaussdbPath:    local?.path || null,
        gaussdbSnippet: local ? extractRelevantSnippet(local.content, f.patch, patchInfo) : null,
      };
    });

    if (fileContexts.length === 0) {
      const result = buildResult(prNumber, pr, files, [], {
        summary: `此 PR 未修改 ${profile.name} 关注的源文件，与当前 Profile 驱动逻辑无关`,
        bugType: '其他', riskLevel: 'NOT_APPLICABLE',
        fixStatus: 'NOT_PRESENT',
        riskReason: profile.upstreamPathPrefix
          ? `变更文件不在上游路径 ${profile.upstreamPathPrefix} 下，或不是当前 Profile 关注的源文件类型`
          : '变更仅涉及当前 Profile 不关注的构建脚本/文档/测试等文件',
        evidence: [],
        affectedFiles: [], recommendation: '无需处理', hasCorrespondingCode: false,
      }, profile);
      writeFileSync(cacheFile, JSON.stringify(result, null, 2));
      return res.json(result);
    }

    const ruleBasedPreClassification = aggregateRuleBasedPreClassification(fileContexts);
    if (isHighConfidenceRule(ruleBasedPreClassification)) {
      const analysis = buildRuleBasedAnalysis(pr, fileContexts, ruleBasedPreClassification);
      const result = buildResult(prNumber, pr, files, fileContexts, analysis, profile, ruleBasedPreClassification);
      writeFileSync(cacheFile, JSON.stringify(result, null, 2));
      return res.json(result);
    }

    const prompt = buildPrompt(pr, prNumber, fileContexts, profile, ruleBasedPreClassification);
    const rawText = await callAI(prompt);

    let analysis;
    try { analysis = parseAnalysisJson(rawText); } catch {}
    if (!analysis) {
      try {
        const repairedText = await callAI(buildJsonRepairPrompt(rawText));
        analysis = parseAnalysisJson(repairedText);
      } catch {}
    }
    if (!analysis) {
      analysis = {
        summary: stripReasoningText(rawText).slice(0, 200),
        bugType: '其他', riskLevel: 'UNKNOWN',
        fixStatus: 'UNCLEAR',
        riskReason: 'AI 输出不是合法 JSON，已去除推理文本后仍解析失败。请重新分析或更换非推理模型。',
        evidence: [],
        affectedFiles: [], recommendation: '', hasCorrespondingCode: false,
      };
    }
    analysis = normalizeAnalysis(analysis, fileContexts, ruleBasedPreClassification);

    const result = buildResult(prNumber, pr, files, fileContexts, analysis, profile, ruleBasedPreClassification);
    writeFileSync(cacheFile, JSON.stringify(result, null, 2));
    res.json(result);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── All analyses ────────────────────────────────────────────────────────────

app.get('/api/analyses', (req, res) => {
  const profile = profileFromRequest(req);
  const results = [];
  readdirSync(DATA_DIR)
    .filter(f => f.startsWith(`${profile.id}_analysis_`) && f.endsWith('.json'))
    .forEach(f => {
      try {
        const result = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'));
        if (result.analysisPromptVersion === ANALYSIS_PROMPT_VERSION && result.profile?.id === profile.id) results.push(result);
      } catch {}
    });
  res.json(results.sort((a, b) => new Date(b.analyzedAt) - new Date(a.analyzedAt)));
});

// ─── Debug ──────────────────────────────────────────────────────────────────

app.get('/api/debug', (req, res) => {
  const s = loadSettings();
  const profile = getProfile(s.driverProfile);
  res.json({
    driverProfile:   profile.id,
    driverName:      profile.name,
    upstreamRepo:    profile.upstreamRepo,
    localPath:       localPathForProfile(s, profile) || '(未设置)',
    aiProvider:      s.aiProvider,
    model:           s.aiProvider === 'minimax' ? s.minimaxModel : s.anthropicModel,
    baseUrl:         s.aiProvider === 'minimax' ? s.minimaxBaseUrl : (s.anthropicBaseUrl || 'https://api.anthropic.com'),
    proxy:           s.proxy || '(无)',
    hasKey:          s.aiProvider === 'minimax' ? !!s.minimaxApiKey : !!s.anthropicApiKey,
    gaussdbOdbcPath: s.gaussdbOdbcPath || '(未设置)',
    gaussdbJdbcPath: s.gaussdbJdbcPath || '(未设置)',
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function parsePatch(patch) {
  const info = { addedLines: [], removedLines: [], identifiers: [], functionNames: [], hunkHeaders: [] };
  if (!patch) return info;

  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) info.hunkHeaders.push(line.slice(0, 200));
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) info.addedLines.push(line.slice(1).trim());
    if (line.startsWith('-')) info.removedLines.push(line.slice(1).trim());
  }

  const identifierText = [
    ...info.addedLines,
    ...info.removedLines,
    ...info.hunkHeaders,
  ].join('\n');
  const ignored = new Set([
    'if', 'else', 'for', 'while', 'return', 'sizeof', 'static', 'const',
    'char', 'int', 'long', 'short', 'void', 'NULL', 'TRUE', 'FALSE',
    ...COMMON_CALL_IGNORES,
  ]);
  info.identifiers = [...new Set((identifierText.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) || [])
    .filter(token => !ignored.has(token))
    .filter(token => !/^PG[A-Z0-9_]*$/.test(token))
  )].slice(0, 40);
  info.functionNames = extractFunctionNamesFromText(identifierText)
    .filter(token => !ignored.has(token))
    .filter(token => !/^PG[A-Z0-9_]*$/.test(token))
    .slice(0, 20);

  return info;
}

function extractFunctionNamesFromText(text) {
  return [...new Set((String(text || '').match(/\b[A-Za-z_][A-Za-z0-9_]*\s*\(/g) || [])
    .map(item => item.replace(/\s*\($/, ''))
    .filter(name => name.length >= 3 && !COMMON_CALL_IGNORES.has(name))
  )];
}

function normalizeCodeLine(line) {
  return String(line || '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/\/\/.*$/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function meaningfulChangedLines(lines) {
  return lines
    .map(line => line.trim())
    .filter(line => line.length >= 8)
    .filter(line => !line.startsWith('//'))
    .filter(line => !line.startsWith('/*'))
    .filter(line => !line.startsWith('*'))
    .filter(line => !line.startsWith('#'))
    .filter(line => !/^[{}();]+$/.test(line))
    .slice(0, 30);
}

function extractPatchFacts(patchInfo) {
  const addedAnchors = meaningfulChangedLines(patchInfo.addedLines).slice(0, 20);
  const removedAnchors = meaningfulChangedLines(patchInfo.removedLines).slice(0, 20);
  return {
    changedFunctions: patchInfo.functionNames.slice(0, 12),
    addedAnchors,
    removedAnchors,
    identifiers: patchInfo.identifiers.slice(0, 20),
    hunkHeaders: patchInfo.hunkHeaders.slice(0, 8),
  };
}

function buildLocalPatchSignals(localContent, patchInfo) {
  const localLines = String(localContent || '').split('\n');
  const normalizedLocal = normalizeCodeLine(localContent);
  const patchFacts = extractPatchFacts(patchInfo);
  const added = patchFacts.addedAnchors;
  const removed = patchFacts.removedAnchors;
  const addedPresent = added.filter(line => normalizedLocal.includes(normalizeCodeLine(line)));
  const removedPresent = removed.filter(line => normalizedLocal.includes(normalizeCodeLine(line)));
  const exactAddedMatches = findExactChangedLineMatches(localLines, added).slice(0, 12);
  const exactRemovedMatches = findExactChangedLineMatches(localLines, removed).slice(0, 12);
  const functionNamePresence = Object.fromEntries(
    patchInfo.functionNames.slice(0, 12).map(name => [name, new RegExp(`\\b${escapeRegExp(name)}\\b`).test(localContent)])
  );
  const preClassification = classifyLocalEvidence({
    hasLocalFile: true,
    exactAddedMatches,
    exactRemovedMatches,
    addedPresent,
    removedPresent,
    patchFacts,
  });
  return {
    patchFacts,
    addedLineCount: added.length,
    removedLineCount: removed.length,
    addedPresentCount: addedPresent.length,
    removedPresentCount: removedPresent.length,
    addedPresentSamples: addedPresent.slice(0, 8),
    removedPresentSamples: removedPresent.slice(0, 8),
    exactAddedMatches,
    exactRemovedMatches,
    functionNamePresence,
    preClassification,
  };
}

function classifyLocalEvidence({ hasLocalFile, exactAddedMatches = [], exactRemovedMatches = [], addedPresent = [], removedPresent = [], patchFacts = {} }) {
  if (!hasLocalFile) {
    return {
      fixStatus: 'NOT_PRESENT',
      confidence: 'HIGH',
      reason: '本地未找到对应产品源文件。',
    };
  }

  const addedExact = exactAddedMatches.length;
  const removedExact = exactRemovedMatches.length;
  const addedAny = addedPresent.length;
  const removedAny = removedPresent.length;
  const addedAnchorTotal = patchFacts.addedAnchors?.length || 0;
  const removedAnchorTotal = patchFacts.removedAnchors?.length || 0;

  if (addedExact > 0 && removedExact === 0) {
    return {
      fixStatus: 'ALREADY_FIXED',
      confidence: addedExact >= Math.min(2, Math.max(1, addedAnchorTotal)) ? 'HIGH' : 'MEDIUM',
      reason: '本地精确命中上游新增修复代码行，且未精确命中上游删除的旧逻辑。',
    };
  }

  if (removedExact > 0 && addedExact === 0) {
    return {
      fixStatus: 'NEEDS_FIX',
      confidence: removedExact >= Math.min(2, Math.max(1, removedAnchorTotal)) ? 'HIGH' : 'MEDIUM',
      reason: '本地精确命中上游删除的旧逻辑，且未精确命中上游新增修复代码行。',
    };
  }

  if (addedExact > 0 && removedExact > 0) {
    return {
      fixStatus: 'UNCLEAR',
      confidence: 'MEDIUM',
      reason: '本地同时命中上游新增修复行和删除旧逻辑，可能存在部分合入或代码重构，需要结合函数上下文判断。',
    };
  }

  if (addedAny > 0 && removedAny === 0) {
    return {
      fixStatus: 'ALREADY_FIXED',
      confidence: 'MEDIUM',
      reason: '本地归一化命中部分上游新增修复逻辑，未命中删除旧逻辑。',
    };
  }

  if (removedAny > 0 && addedAny === 0) {
    return {
      fixStatus: 'NEEDS_FIX',
      confidence: 'MEDIUM',
      reason: '本地归一化命中部分上游删除旧逻辑，未命中新增修复逻辑。',
    };
  }

  return {
    fixStatus: 'UNCLEAR',
    confidence: 'LOW',
    reason: '未直接命中上游新增或删除的关键代码行，需要结合函数级上下文判断。',
  };
}

function aggregateRuleBasedPreClassification(fileContexts) {
  const matched = fileContexts.filter(f => f.gaussdbPath && f.localSignals?.preClassification);
  if (matched.length === 0) {
    return {
      fixStatus: 'NOT_PRESENT',
      confidence: 'HIGH',
      reason: '未在本地仓库中找到对应产品源文件。',
      evidence: [],
    };
  }

  const evidence = [];
  for (const f of matched) {
    const signals = f.localSignals;
    for (const item of signals.exactAddedMatches || []) {
      evidence.push(`本地精确命中上游新增修复行：${f.gaussdbPath}:${item.line} ${item.code}`);
    }
    for (const item of signals.exactRemovedMatches || []) {
      evidence.push(`本地精确命中上游删除旧逻辑：${f.gaussdbPath}:${item.line} ${item.code}`);
    }
  }

  const needsFix = matched.find(f => f.localSignals.preClassification.fixStatus === 'NEEDS_FIX'
    && ['HIGH', 'MEDIUM'].includes(f.localSignals.preClassification.confidence));
  if (needsFix) {
    return {
      fixStatus: 'NEEDS_FIX',
      confidence: needsFix.localSignals.preClassification.confidence,
      reason: needsFix.localSignals.preClassification.reason,
      evidence: evidence.slice(0, 8),
    };
  }

  const alreadyFixed = matched.find(f => f.localSignals.preClassification.fixStatus === 'ALREADY_FIXED'
    && ['HIGH', 'MEDIUM'].includes(f.localSignals.preClassification.confidence));
  const hasNeedsExact = matched.some(f => (f.localSignals.exactRemovedMatches || []).length > 0);
  if (alreadyFixed && !hasNeedsExact) {
    return {
      fixStatus: 'ALREADY_FIXED',
      confidence: alreadyFixed.localSignals.preClassification.confidence,
      reason: alreadyFixed.localSignals.preClassification.reason,
      evidence: evidence.slice(0, 8),
    };
  }

  return {
    fixStatus: 'UNCLEAR',
    confidence: 'LOW',
    reason: '规则层未形成确定结论，需要结合函数级上下文和模型分析。',
    evidence: evidence.slice(0, 8),
  };
}

function findExactChangedLineMatches(lines, changedLines) {
  const normalizedChanged = changedLines
    .map(line => ({ source: line, normalized: normalizeCodeLine(line) }))
    .filter(item => item.normalized.length >= 8);
  const matches = [];
  lines.forEach((line, index) => {
    const normalizedLocal = normalizeCodeLine(line);
    if (!normalizedLocal) return;
    for (const changed of normalizedChanged) {
      if (normalizedLocal === changed.normalized) {
        matches.push({ line: index + 1, code: line.trim(), patchLine: changed.source });
      }
    }
  });
  return matches;
}

function formatSnippetWithLineNumbers(lines, indexes) {
  return [...indexes].sort((a, b) => a - b)
    .map(i => `${String(i + 1).padStart(5, ' ')}: ${lines[i]}`)
    .join('\n');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findFunctionDefinitionStart(lines, name, aroundIndex = -1) {
  const escaped = escapeRegExp(name);
  const candidates = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return;
    if (!new RegExp(`\\b${escaped}\\s*\\(`).test(line)) return;
    const signature = lines.slice(i, Math.min(lines.length, i + 12)).join(' ');
    if (!new RegExp(`\\b${escaped}\\s*\\([^;]*\\)\\s*\\{`).test(signature)) return;
    candidates.push(i);
  });
  if (candidates.length === 0) return -1;
  if (aroundIndex < 0) return candidates[0];
  return candidates.sort((a, b) => Math.abs(a - aroundIndex) - Math.abs(b - aroundIndex))[0];
}

function findFunctionEnd(lines, start) {
  let depth = 0;
  let seenBrace = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') {
        depth += 1;
        seenBrace = true;
      } else if (ch === '}') {
        depth -= 1;
        if (seenBrace && depth <= 0) return i;
      }
    }
  }
  return Math.min(lines.length - 1, start + 120);
}

function sectionWithLineNumbers(title, lines, start, end) {
  const safeStart = Math.max(0, start);
  const safeEnd = Math.min(lines.length - 1, end);
  const indexes = [];
  for (let i = safeStart; i <= safeEnd; i++) indexes.push(i);
  return `// ${title}\n${formatSnippetWithLineNumbers(lines, indexes)}`;
}

function addExactMatchSections(sections, seenRanges, lines, patchInfo) {
  const changedLines = [
    ...meaningfulChangedLines(patchInfo.addedLines).map(code => ({ kind: 'added', code })),
    ...meaningfulChangedLines(patchInfo.removedLines).map(code => ({ kind: 'removed', code })),
  ];
  if (changedLines.length === 0) return;

  const normalizedChanged = changedLines
    .map(item => ({ ...item, normalized: normalizeCodeLine(item.code) }))
    .filter(item => item.normalized.length >= 8);

  lines.forEach((line, i) => {
    if (sections.length >= 8) return;
    const normalizedLocal = normalizeCodeLine(line);
    const hit = normalizedChanged.find(item => item.normalized === normalizedLocal);
    if (!hit) return;
    const start = Math.max(0, i - 25);
    const end = Math.min(lines.length - 1, i + 45);
    const rangeKey = `${start}:${end}`;
    if (seenRanges.has(rangeKey)) return;
    seenRanges.add(rangeKey);
    sections.push(sectionWithLineNumbers(`local exact ${hit.kind} patch-line match near line ${i + 1}`, lines, start, end));
  });
}

function extractRelevantSnippet(fileContent, patch, patchInfo = parsePatch(patch)) {
  if (!fileContent) return null;
  if (!patch) return fileContent.split('\n').slice(0, 160).map((line, i) => `${String(i + 1).padStart(5, ' ')}: ${line}`).join('\n');

  const lines = fileContent.split('\n');
  const sections = [];
  const seenRanges = new Set();
  addExactMatchSections(sections, seenRanges, lines, patchInfo);

  const functionNames = [
    ...patchInfo.functionNames,
    ...extractFunctionNamesFromText(patch),
  ].filter(Boolean);
  const keyNames = [...new Set(functionNames)].slice(0, 12);

  for (const name of keyNames) {
    const matchIndexes = [];
    lines.forEach((line, i) => {
      if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(line)) matchIndexes.push(i);
    });
    if (matchIndexes.length === 0) continue;

    const defStart = findFunctionDefinitionStart(lines, name, matchIndexes[0]);
    if (defStart >= 0) {
      const defEnd = findFunctionEnd(lines, defStart);
      const start = Math.max(0, defStart - 8);
      const end = Math.min(lines.length - 1, defEnd + 8);
      const rangeKey = `${start}:${end}`;
      if (!seenRanges.has(rangeKey)) {
        seenRanges.add(rangeKey);
        sections.push(sectionWithLineNumbers(`local function context: ${name}`, lines, start, end));
      }
      continue;
    }

    const first = matchIndexes[0];
    const start = Math.max(0, first - 20);
    const end = Math.min(lines.length - 1, first + 40);
    const rangeKey = `${start}:${end}`;
    if (!seenRanges.has(rangeKey)) {
      seenRanges.add(rangeKey);
      sections.push(sectionWithLineNumbers(`local identifier context: ${name}`, lines, start, end));
    }
  }

  if (sections.length < 3) {
    const identifiers = patchInfo.identifiers.slice(0, 20);
    lines.forEach((line, i) => {
      if (sections.length >= 6) return;
      if (!identifiers.some(token => line.includes(token))) return;
      const start = Math.max(0, i - 20);
      const end = Math.min(lines.length - 1, i + 40);
      const rangeKey = `${start}:${end}`;
      if (!seenRanges.has(rangeKey)) {
        seenRanges.add(rangeKey);
        sections.push(sectionWithLineNumbers(`local patch-identifier context near line ${i + 1}`, lines, start, end));
      }
    });
  }

  const snippet = sections.length
    ? sections.join('\n\n')
    : lines.slice(0, 180).map((line, i) => `${String(i + 1).padStart(5, ' ')}: ${line}`).join('\n');
  return snippet.slice(0, 14000);
}

function driverSkillPrompt(profile) {
  return `
## 自动启用的驱动专家分析方法：${ANALYSIS_METHOD}

点击“分析”时必须按下面流程执行。这是内置的数据库驱动源码确认流程，相当于自动调用驱动分析技能，但不依赖外部 Codex skill 运行时。

1. 先识别上游 PR 的真实修复点：
   - 找出新增的防护逻辑、删除的旧逻辑、改动函数、直接 callee、关键条件判断。
   - 区分产品运行时代码与 test/docs/example 变更。测试文件缺失不能单独构成产品风险。

2. 再确认本地源码事实：
   - 只把给出的 GaussDB 本地代码片段、函数名、变量名、行号、命中信号当作事实。
   - 如果本地片段展示了修复函数和调用点，要围绕这些事实判断是否等价修复。
   - 如果本地片段仅缺少无关上下文，不得直接推断 NEEDS_FIX。

3. 建立最小调用链/数据流：
   - 对连接参数、URL/DSN、协议、描述符、结果集、类型转换、内存边界等驱动场景，说明问题从哪个公开入口或内部函数进入。
   - 判断上游修复点在本地是否仍可通过相同路径触发。
   - 如果调用链无法从给定片段确认，fixStatus 用 UNCLEAR，不要输出 HIGH，除非已有明确旧逻辑证据。

4. 做等价修复比对：
   - 如果本地存在上游新增校验、边界检查、状态恢复、资源释放、异常处理、协议兼容逻辑，且调用点也存在，优先输出 ALREADY_FIXED。
   - 如果本地仍保留上游删除的旧逻辑，并缺少新增修复逻辑，才输出 NEEDS_FIX。
   - 如果本地没有对应产品代码，输出 NOT_PRESENT。

5. 输出证据要求：
   - riskReason 和 evidence 必须引用本地文件、函数、变量、行号或具体代码行为。
   - 不要把“测试文件不存在”“未展示全文”“建议人工确认”作为 HIGH 风险依据。
   - 证据不足时输出 UNCLEAR/UNKNOWN，并写明缺少哪个最小函数或调用点。

当前 Profile：${profile.name}。请按该 Profile 的驱动语义分析，不要跨驱动猜测。`;
}

function buildPrompt(pr, prNumber, fileContexts, profile, ruleBasedPreClassification) {
  return `/no_think
你是资深数据库驱动开发工程师，${profile.promptExpert}。你现在做的是“上游修复同步评估”，不是泛泛总结 PR。

重要输出约束：
- 只输出一个 JSON 对象。
- 不要输出 <think>、</think>、思考过程、解释文字、markdown 代码块。
- 第一个字符必须是 {，最后一个字符必须是 }。

## 任务
分析 ${profile.upstreamLabel} PR #${prNumber}，判断${profile.promptTarget}是否：
1. 已经合入等价修复，不需要再改；
2. 仍存在上游修复前的缺陷，需要同步；
3. 本地无对应代码；
4. 证据不足，无法判断。

必须基于给出的 GaussDB 本地代码片段和上游 diff 做证据判断。禁止只说“需要确认/建议检查”。如果本地代码已经包含上游新增的防护逻辑、边界检查、状态重置、unbind 例外等修复行为，应明确输出 ALREADY_FIXED 和 NOT_APPLICABLE。

${driverSkillPrompt(profile)}

重要判断边界：
- 本地代码来自用户在页面或环境变量中配置的仓库路径；不要假设其他机器或示例路径中的代码状态。
- 已过滤上游 test / docs / example 类文件，测试文件不存在不能作为 NEEDS_FIX 或 HIGH 风险证据。
- GaussDB 对应代码是按 patch 标识符和函数名抽取的分段函数级上下文，不是文件全文；不得因为未展示测试文件或无关函数就提升风险等级。
- 本地代码命中信号中的 exactAddedMatches / exactRemovedMatches 是最强证据：exactAddedMatches 表示上游新增修复行在本地已存在；exactRemovedMatches 表示上游删除旧逻辑仍在本地存在。
- 如果本地上下文已经展示修复函数、调用点或等价校验逻辑，必须优先判断是否 ALREADY_FIXED。
- 如果只缺测试文件，但运行时代码已经修复，应输出 ALREADY_FIXED；测试补充只能作为 recommendation 的附加建议，不能作为风险依据。

## PR 信息
- 上游仓库：${profile.upstreamRepo}
- 当前驱动 Profile：${profile.name}
- 标题：${pr.title}
- 描述：${(pr.body || '无描述').slice(0, 600)}

## 程序确定性初判
这是后端基于上游新增/删除代码行和本地代码精确命中结果生成的规则初判。你必须优先参考它；如果要推翻，必须在本地函数级上下文中给出更强证据。

\`\`\`json
${JSON.stringify(ruleBasedPreClassification || {}, null, 2)}
\`\`\`

## 变更文件分析
${fileContexts.map(f => `
### 上游文件：${f.upstreamFile}
**社区修复 diff：**
\`\`\`diff
${f.patch}
\`\`\`

**上游新增修复线索（+ 行，节选）：**
\`\`\`text
${f.patchInfo.addedLines.filter(Boolean).slice(0, 40).join('\n') || '无'}
\`\`\`

**上游删除/替换的旧逻辑线索（- 行，节选）：**
\`\`\`text
${f.patchInfo.removedLines.filter(Boolean).slice(0, 40).join('\n') || '无'}
\`\`\`

**本地代码命中信号：**
\`\`\`json
${JSON.stringify(f.localSignals || { found: false }, null, 2)}
\`\`\`

${f.gaussdbSnippet
  ? `**GaussDB 对应代码（${f.gaussdbPath}，左侧为本地行号；按相关函数/标识符分段抽取）：**\n\`\`\`${profile.codeFence}\n${f.gaussdbSnippet}\n\`\`\``
  : `**GaussDB 中未找到文件 ${f.upstreamFile}**`
}
`).join('\n---\n')}

## 判断规则
- fixStatus 只能是 "ALREADY_FIXED"、"NEEDS_FIX"、"NOT_PRESENT"、"UNCLEAR" 之一。
- 如果 GaussDB 本地代码已经有等价修复，riskLevel 必须是 "NOT_APPLICABLE"，recommendation 应说明“无需修改”，riskReason 必须引用本地文件/函数/行号附近的证据。
- 如果 GaussDB 本地代码仍保留上游删除的旧逻辑，且缺少上游新增修复逻辑，fixStatus 用 "NEEDS_FIX"，riskLevel 按影响给 HIGH/MEDIUM/LOW。
- 如果只找到文件但证据不足，fixStatus 用 "UNCLEAR"，riskLevel 用 "LOW" 或 "UNKNOWN"，recommendation 写明还缺少哪段代码证据。
- bugType 只能从 ["内存安全","空指针","缓冲区溢出","逻辑错误","资源泄漏","数据绑定错误","事务状态错误","协议兼容","并发安全","构建/测试","其他"] 中选一个，不能照抄整个候选列表。
- evidence 必须列出至少 2 条本地代码证据；如果没有对应代码，写空数组。
- 不允许把 "A/B/C" 这种候选说明原样输出到任何字段中，必须选择单个枚举值。

## 输出（严格 JSON，不含其他内容，不要 markdown）
{
  "summary": "一句话说明上游 PR 修复的问题",
  "fixStatus": "NEEDS_FIX",
  "bugType": "逻辑错误",
  "riskLevel": "MEDIUM",
  "riskReason": "明确说明本地是否已修复或仍有风险，必须引用本地函数名、变量名、行号或代码行为",
  "evidence": [
    "本地证据1：文件、行号、函数/变量、说明它证明已修复或未修复",
    "本地证据2：文件、行号、函数/变量、说明它证明已修复或未修复"
  ],
  "affectedFiles": ["GaussDB受影响文件路径；如已修复，也列出已确认的文件"],
  "recommendation": "如果 ALREADY_FIXED 写无需修改；如果 NEEDS_FIX 写具体修复点；如果 UNCLEAR 写需要人工确认的最小代码点",
  "hasCorrespondingCode": true
}`;
}

function stripReasoningText(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
}

function extractBalancedJsonObjectFrom(input, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return null;
}

function candidateJsonObjects(text) {
  const input = stripReasoningText(text);
  const candidates = [];
  for (let start = input.indexOf('{'); start >= 0; start = input.indexOf('{', start + 1)) {
    const candidate = extractBalancedJsonObjectFrom(input, start);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function parseAnalysisJson(text) {
  const cleaned = stripReasoningText(text);
  try { return JSON.parse(cleaned); } catch {}

  const fenced = cleaned.match(/```json\s*([\s\S]*?)\s*```/i) || cleaned.match(/```\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }

  for (const candidate of candidateJsonObjects(cleaned)) {
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

function buildJsonRepairPrompt(rawText) {
  return `/no_think
下面是一段模型输出。请删除所有 <think>、解释、markdown，只提取或重写为一个严格合法 JSON 对象。
要求：
- 只输出 JSON 对象，不要输出任何其他字符。
- 字段必须包含 summary, fixStatus, bugType, riskLevel, riskReason, evidence, affectedFiles, recommendation, hasCorrespondingCode。
- fixStatus 只能是 ALREADY_FIXED, NEEDS_FIX, NOT_PRESENT, UNCLEAR。
- riskLevel 只能是 HIGH, MEDIUM, LOW, NOT_APPLICABLE, UNKNOWN。
- evidence 和 affectedFiles 必须是数组。

原始输出：
${String(rawText || '').slice(0, 6000)}`;
}

function normalizeAnalysis(analysis, fileContexts, ruleBasedPreClassification = null) {
  const allowedFixStatus = new Set(['ALREADY_FIXED', 'NEEDS_FIX', 'NOT_PRESENT', 'UNCLEAR']);
  const allowedRisk = new Set(['HIGH', 'MEDIUM', 'LOW', 'NOT_APPLICABLE', 'UNKNOWN']);
  const allowedBugTypes = new Set([
    '内存安全', '空指针', '缓冲区溢出', '逻辑错误', '资源泄漏',
    '数据绑定错误', '事务状态错误', '协议兼容', '并发安全', '构建/测试', '其他',
  ]);
  const hasLocalMatch = fileContexts.some(f => f.gaussdbPath);

  const result = { ...analysis };
  if (!allowedFixStatus.has(result.fixStatus)) {
    result.fixStatus = hasLocalMatch ? 'UNCLEAR' : 'NOT_PRESENT';
  }
  if (!allowedRisk.has(result.riskLevel)) {
    result.riskLevel = result.fixStatus === 'ALREADY_FIXED' || result.fixStatus === 'NOT_PRESENT'
      ? 'NOT_APPLICABLE'
      : 'UNKNOWN';
  }
  if (!allowedBugTypes.has(result.bugType) || String(result.bugType || '').includes('/')) {
    result.bugType = '其他';
  }
  if (result.fixStatus === 'ALREADY_FIXED') {
    result.riskLevel = 'NOT_APPLICABLE';
    if (!result.recommendation || /检查|确认/.test(result.recommendation)) {
      result.recommendation = '无需修改：本地代码证据显示已经合入等价修复。';
    }
  }
  if (result.fixStatus === 'NOT_PRESENT') {
    result.riskLevel = 'NOT_APPLICABLE';
    result.hasCorrespondingCode = false;
  }
  if (!Array.isArray(result.evidence)) result.evidence = [];
  if (!Array.isArray(result.affectedFiles)) result.affectedFiles = [];
  result.hasCorrespondingCode = result.hasCorrespondingCode === true || (hasLocalMatch && result.fixStatus !== 'NOT_PRESENT');

  if (ruleBasedPreClassification?.confidence === 'HIGH') {
    if (ruleBasedPreClassification.fixStatus === 'ALREADY_FIXED') {
      result.fixStatus = 'ALREADY_FIXED';
      result.riskLevel = 'NOT_APPLICABLE';
      result.hasCorrespondingCode = true;
      result.riskReason = `规则层高置信判断本地已包含上游修复：${ruleBasedPreClassification.reason}`;
      result.recommendation = '无需修改：本地精确命中上游新增修复代码行，且未命中对应旧逻辑。';
      result.evidence = [
        ...ruleBasedPreClassification.evidence,
        ...result.evidence,
      ].filter(Boolean).slice(0, 8);
    } else if (ruleBasedPreClassification.fixStatus === 'NEEDS_FIX') {
      result.fixStatus = 'NEEDS_FIX';
      result.hasCorrespondingCode = true;
      if (!['HIGH', 'MEDIUM', 'LOW'].includes(result.riskLevel)) result.riskLevel = 'HIGH';
      result.riskReason = `规则层高置信判断本地仍包含上游删除的旧逻辑：${ruleBasedPreClassification.reason}`;
      result.evidence = [
        ...ruleBasedPreClassification.evidence,
        ...result.evidence,
      ].filter(Boolean).slice(0, 8);
    }
  }
  return result;
}

function isHighConfidenceRule(ruleBasedPreClassification) {
  return ruleBasedPreClassification?.confidence === 'HIGH'
    && ['ALREADY_FIXED', 'NEEDS_FIX', 'NOT_PRESENT'].includes(ruleBasedPreClassification.fixStatus);
}

function inferBugProfileFromPr(pr, fileContexts) {
  const text = [
    pr?.title,
    pr?.body,
    ...fileContexts.flatMap(f => [
      f.upstreamFile,
      ...(f.localSignals?.patchFacts?.addedAnchors || []),
      ...(f.localSignals?.patchFacts?.removedAnchors || []),
    ]),
  ].filter(Boolean).join('\n').toLowerCase();

  if (/(overflow|overrun|buffer|realloc|memcpy|strcpy|strlen|terminator|ubsan|use-after-free|double free|free\()/i.test(text)) {
    return { bugType: '内存安全', riskLevel: 'HIGH' };
  }
  if (/(sql_desc|descriptor|bind|unbind|ard|ird|octet|precision|scale|buffer length)/i.test(text)) {
    return { bugType: '数据绑定错误', riskLevel: 'MEDIUM' };
  }
  if (/(transaction|rollback|savepoint|commit|autocommit|autosave)/i.test(text)) {
    return { bugType: '事务状态错误', riskLevel: 'MEDIUM' };
  }
  if (/(protocol|packet|sync|readyforquery|libpq|wire)/i.test(text)) {
    return { bugType: '协议兼容', riskLevel: 'MEDIUM' };
  }
  if (/(leak|close|free|release|resource|handle)/i.test(text)) {
    return { bugType: '资源泄漏', riskLevel: 'MEDIUM' };
  }
  return { bugType: '其他', riskLevel: 'MEDIUM' };
}

function buildRuleBasedAnalysis(pr, fileContexts, ruleBasedPreClassification) {
  const { bugType, riskLevel } = inferBugProfileFromPr(pr, fileContexts);
  const affectedFiles = fileContexts
    .filter(f => f.gaussdbPath)
    .map(f => f.gaussdbPath);
  const evidence = (ruleBasedPreClassification.evidence || [])
    .filter(Boolean)
    .slice(0, 8);
  if (evidence.length === 0 && ruleBasedPreClassification.reason) {
    evidence.push(`规则层证据：${ruleBasedPreClassification.reason}`);
  }

  const addedAnchors = fileContexts
    .flatMap(f => f.localSignals?.patchFacts?.addedAnchors || [])
    .filter(Boolean)
    .slice(0, 4);

  if (ruleBasedPreClassification.fixStatus === 'ALREADY_FIXED') {
    return {
      summary: `上游 PR 修复“${pr.title}”，本地已精确命中上游新增修复代码行。`,
      fixStatus: 'ALREADY_FIXED',
      bugType,
      riskLevel: 'NOT_APPLICABLE',
      riskReason: `规则层高置信判断本地已包含上游修复：${ruleBasedPreClassification.reason}`,
      evidence,
      affectedFiles,
      recommendation: '无需修改：本地已命中上游新增修复代码行，且未命中对应旧逻辑。',
      hasCorrespondingCode: affectedFiles.length > 0,
      analysisSource: 'rule-based',
    };
  }

  if (ruleBasedPreClassification.fixStatus === 'NEEDS_FIX') {
    const repairHint = addedAnchors.length > 0
      ? `建议同步上游新增修复逻辑，重点核对：${addedAnchors.join('；')}`
      : '建议同步上游新增修复逻辑，并优先处理证据中列出的本地文件和行号。';
    return {
      summary: `上游 PR 修复“${pr.title}”，本地仍精确命中上游删除的旧逻辑。`,
      fixStatus: 'NEEDS_FIX',
      bugType,
      riskLevel,
      riskReason: `规则层高置信判断本地仍包含上游删除的旧逻辑：${ruleBasedPreClassification.reason}`,
      evidence,
      affectedFiles,
      recommendation: repairHint,
      hasCorrespondingCode: affectedFiles.length > 0,
      analysisSource: 'rule-based',
    };
  }

  return {
    summary: `上游 PR “${pr.title}” 在本地未找到对应产品代码。`,
    fixStatus: 'NOT_PRESENT',
    bugType: '其他',
    riskLevel: 'NOT_APPLICABLE',
    riskReason: ruleBasedPreClassification.reason || '本地未找到对应产品源文件。',
    evidence: [],
    affectedFiles: [],
    recommendation: '无需处理当前 Profile 的产品代码。',
    hasCorrespondingCode: false,
    analysisSource: 'rule-based',
  };
}

function buildResult(prNumber, pr, files, fileContexts, analysis, profile, ruleBasedPreClassification = null) {
  return {
    prNumber:     parseInt(prNumber),
    prTitle:      pr.title,
    prUrl:        pr.html_url,
    mergedAt:     pr.merged_at,
    analyzedAt:   new Date().toISOString(),
    analysisPromptVersion: ANALYSIS_PROMPT_VERSION,
    analysisMethod: ANALYSIS_METHOD,
    ruleBasedPreClassification,
    profile:       publicProfile(profile),
    changedFiles: files.map(f => f.filename),
    matchedFiles: fileContexts.filter(f => f.gaussdbPath).map(f => ({
      upstream: f.upstreamFile,
      local:    f.gaussdbPath,
    })),
    ...analysis,
  };
}

const DEFAULT_PORT = 3000;
const PORT = parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
const MAX_PORT_ATTEMPTS = process.env.PORT ? 1 : 20;

function logStartup(port) {
  const s = loadSettings();
  const provider = s.aiProvider || 'anthropic';
  const profile = getProfile(s.driverProfile);
  console.log(`GaussDB PR Tracker → http://localhost:${port}`);
  console.log(`  Driver   : ${profile.name} (${profile.upstreamRepo})`);
  console.log(`  Provider : ${provider.toUpperCase()}`);
  console.log(`  Model    : ${provider === 'minimax' ? s.minimaxModel : s.anthropicModel}`);
  console.log(`  Base URL : ${provider === 'minimax' ? s.minimaxBaseUrl : (s.anthropicBaseUrl || 'https://api.anthropic.com')}`);
  console.log(`  Proxy    : ${s.proxy || '(无)'}`);
  console.log(`  Code Path: ${localPathForProfile(s, profile) || '(未配置)'}`);
}

function startServer(port, remainingAttempts = MAX_PORT_ATTEMPTS) {
  const server = app.listen(port, () => logStartup(port));
  server.on('error', err => {
    if (err.code === 'EADDRINUSE' && remainingAttempts > 1) {
      console.warn(`Port ${port} is already in use, trying ${port + 1}...`);
      startServer(port + 1, remainingAttempts - 1);
      return;
    }

    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Set another port, for example: PORT=${port + 1} npm start`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}

export const __test = {
  parsePatch,
  extractPatchFacts,
  buildLocalPatchSignals,
  aggregateRuleBasedPreClassification,
  buildRuleBasedAnalysis,
  isHighConfidenceRule,
  extractRelevantSnippet,
  findFunctionDefinitionStart,
};

if (process.env.NODE_ENV !== 'test') {
  startServer(PORT);
}
