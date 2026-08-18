const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const {
  resolveProfile,
  getSelectedProfileId,
  instanceModsDir,
  readProfileCustomMods,
  writeProfileCustomMods,
  listModpacks,
  loadModpack,
  enforceEssentialMods,
  isModEnabled,
  isModLocked
} = require('./modpackRegistry');

const MODRINTH_API = 'https://api.modrinth.com/v2';
const CURSEFORGE_API = 'https://api.curseforge.com/v1';
const USER_AGENT = 'BloodPact-Launcher/1.0.0 (contact@bloodpact.local)';
const MINECRAFT_GAME_ID = 432;
const MOD_CLASS_ID = 6;
const MOD_LOADER_TYPES = {
  fabric: 4,
  forge: 1,
  quilt: 5,
  neoforge: 6
};
const CURSEFORGE_REQUIRED_RELATIONS = new Set([3, 4]);
const FABRIC_API_MODRINTH_ID = 'P7dR8mSH';

function isRetryableNetworkError(error) {
  const code = error?.code || '';
  const message = error?.message || String(error);
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(`${code} ${message}`);
}

async function withNetworkRetry(task, options = {}) {
  const attempts = options.attempts || 3;
  const delayMs = options.delayMs || 1500;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!isRetryableNetworkError(error) || attempt >= attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }

  throw lastError;
}

function stripJsonBom(text) {
  if (!text) {
    return text;
  }
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function parseJsonString(text, fallback) {
  try {
    return JSON.parse(stripJsonBom(text));
  } catch {
    return fallback;
  }
}

function readJson(filePath, fallback) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(stripJsonBom(text));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const utf8NoBom = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  fs.writeFileSync(filePath, utf8NoBom);
}

function formatModNetworkError(error) {
  const message = error?.message || String(error || '');
  const code = error?.code || '';
  const blob = `${code} ${message}`;
  if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|Connect Timeout/i.test(blob)) {
    return 'Could not reach Modrinth (network dropped). If you already played once, click Play again — cached mods may still work.';
  }
  return message;
}

function fetchJson(url, options = {}) {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    ...(options.headers || {})
  };

  return withNetworkRetry(() => new Promise((resolve, reject) => {
    const request = https.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          const label = options.label || 'API';
          let detail = body.trim();
          if (detail.length > 180) {
            detail = `${detail.slice(0, 180)}…`;
          }
          reject(new Error(`${label} request failed (${res.statusCode})${detail ? `: ${detail}` : ''}`));
          return;
        }
        try {
          resolve(parseJsonString(body, {}));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', (error) => {
      reject(new Error(formatModNetworkError(error)));
    });
    request.setTimeout(options.timeoutMs || 30000, () => {
      request.destroy(new Error('Modrinth request timed out'));
    });
  }), options);
}

function resolveLauncherDir(fromPath) {
  const normalized = path.resolve(fromPath);
  if (fs.existsSync(path.join(normalized, 'modpacks'))) {
    return normalized;
  }
  if (fs.existsSync(path.join(normalized, 'launcher', 'modpacks'))) {
    return path.join(normalized, 'launcher');
  }
  return normalized;
}

function readSharePackDefaults(launcherDir) {
  const sharePackPath = path.join(launcherDir, 'share-pack.json');
  if (!fs.existsSync(sharePackPath)) {
    return {};
  }
  return readJson(sharePackPath, {});
}

function getCurseForgeApiKey(launcherRootOrBloodpactRoot) {
  const launcherDir = resolveLauncherDir(launcherRootOrBloodpactRoot);
  const config = readJson(path.join(launcherDir, 'config.json'), {});
  const sharePack = readSharePackDefaults(launcherDir);
  return (
    config.curseForgeApiKey
    || sharePack.curseForgeApiKey
    || process.env.BLOODPACT_CURSEFORGE_API_KEY
    || ''
  ).trim();
}

function freeModsCatalogPath(launcherRoot) {
  return path.join(launcherRoot, 'free-mods', 'catalog.json');
}

function loadFreeModsCatalog(launcherRoot) {
  return readJson(freeModsCatalogPath(launcherRoot), { categories: {}, mods: [] });
}

function fetchJsonPost(url, payload, options = {}) {
  const body = JSON.stringify(payload);
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...(options.headers || {})
  };

  return withNetworkRetry(() => new Promise((resolve, reject) => {
    const request = https.request(url, { method: 'POST', headers }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => (responseBody += chunk));
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          const label = options.label || 'API';
          reject(new Error(`${label} request failed (${res.statusCode})`));
          return;
        }
        try {
          resolve(JSON.parse(responseBody));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  }), options);
}

function hashFile(filePath, algorithm) {
  const hash = crypto.createHash(algorithm);
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function downloadFile(url, destination) {
  return withNetworkRetry(() => new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const file = fs.createWriteStream(destination);
    const fail = (error) => {
      file.close(() => {
        try {
          if (fs.existsSync(destination)) {
            fs.unlinkSync(destination);
          }
        } catch {
          // Ignore cleanup errors.
        }
        reject(error);
      });
    };

    https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try {
          if (fs.existsSync(destination)) {
            fs.unlinkSync(destination);
          }
        } catch {
          // Ignore cleanup errors.
        }
        downloadFile(res.headers.location, destination).then(resolve).catch(reject);
        return;
      }
      res.on('error', fail);
      file.on('error', fail);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destination)));
    }).on('error', fail);
  }));
}

function scanLocalMods(modsDir) {
  if (!fs.existsSync(modsDir)) {
    return [];
  }
  return fs.readdirSync(modsDir)
    .filter((name) => name.endsWith('.jar'))
    .map((name) => ({
      filename: name,
      fullPath: path.join(modsDir, name),
      size: fs.statSync(path.join(modsDir, name)).size
    }));
}

function findBloodpactJarInDir(dir) {
  if (!fs.existsSync(dir)) {
    return null;
  }

  const match = fs.readdirSync(dir)
    .filter((name) => name.startsWith('bloodpact') && name.endsWith('.jar') && !name.includes('-sources'))
    .sort()
    .reverse()[0];

  return match ? path.join(dir, match) : null;
}

function isValidModJar(filePath) {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 1000;
  } catch {
    return false;
  }
}

function filesAreSame(source, target) {
  try {
    if (!fs.existsSync(source) || !fs.existsSync(target)) {
      return false;
    }
    const srcStat = fs.statSync(source);
    const dstStat = fs.statSync(target);
    return srcStat.size === dstStat.size && srcStat.mtimeMs === dstStat.mtimeMs;
  } catch {
    return false;
  }
}

function copyFileIfChanged(source, target) {
  if (filesAreSame(source, target)) {
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return true;
}

function syncStatePath(cacheDir) {
  return path.join(cacheDir, 'sync-state.json');
}

function buildSyncFingerprint(launcherRoot, profileId, modpack, enabledMods, modsDir) {
  const customMods = readProfileCustomMods(launcherRoot, profileId).mods
    .filter((mod) => mod.enabled)
    .map((mod) => ({ id: mod.id, filename: mod.filename, updatedAt: mod.updatedAt }));
  const enabled = {};
  for (const modDef of modpack.mods || []) {
    enabled[modDef.id] = isModEnabled(modDef, enabledMods, modpack);
  }
  const jarFingerprint = listJarFiles(modsDir).sort().map((name) => {
    const stat = fs.statSync(path.join(modsDir, name));
    return `${name}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
  }).join('|');
  return JSON.stringify({
    profileId,
    modpackId: modpack.id,
    enabled,
    customMods,
    jarFingerprint
  });
}

function isPackModJarPresent(modDef, modsDir) {
  const canonical = path.join(modsDir, `${modDef.id}.jar`);
  if (fs.existsSync(canonical) && isValidModJar(canonical)) {
    return true;
  }
  if (modDef.fallbackFilename) {
    return listJarFiles(modsDir).some((file) =>
      jarMatchesHint(file, modDef.fallbackFilename) && isValidModJar(path.join(modsDir, file))
    );
  }
  return false;
}

function arePackModsSatisfied(modpack, enabledMods, modsDir) {
  for (const modDef of modpack.mods || []) {
    if (!isModEnabled(modDef, enabledMods, modpack)) {
      continue;
    }
    if (!isPackModJarPresent(modDef, modsDir)) {
      return false;
    }
  }
  return true;
}

function areCustomModsSatisfied(launcherRoot, profileId, modsDir) {
  for (const mod of readProfileCustomMods(launcherRoot, profileId).mods) {
    if (!mod.enabled) {
      continue;
    }
    if (mod.filename && !fs.existsSync(path.join(modsDir, mod.filename))) {
      return false;
    }
  }
  return true;
}

function canUseFastSync(launcherRoot, profileId, modpack, enabledMods, modsDir, cacheDir) {
  const fingerprint = buildSyncFingerprint(launcherRoot, profileId, modpack, enabledMods, modsDir);
  const state = readJson(syncStatePath(cacheDir), null);
  if (!state || state.fingerprint !== fingerprint) {
    return false;
  }
  return arePackModsSatisfied(modpack, enabledMods, modsDir)
    && areCustomModsSatisfied(launcherRoot, profileId, modsDir);
}

function writeSyncState(cacheDir, fingerprint) {
  writeJson(syncStatePath(cacheDir), {
    fingerprint,
    syncedAt: new Date().toISOString()
  });
}

function findBloodpactJarInTree(rootDir, maxDepth = 4) {
  if (!rootDir || !fs.existsSync(rootDir) || maxDepth < 0) {
    return null;
  }

  const direct = findBloodpactJarInDir(rootDir);
  if (direct) {
    return direct;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }
    const nested = findBloodpactJarInTree(path.join(rootDir, entry.name), maxDepth - 1);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function repairBloodpactJarLayout(bloodpactRoot, launcherDir) {
  if (!bloodpactRoot || !launcherDir) {
    return null;
  }

  const targets = [
    path.join(bloodpactRoot, 'bundled-mods', 'bloodpact-26.1.2-1.0.0.jar'),
    path.join(launcherDir, 'bundled-mods', 'bloodpact-26.1.2-1.0.0.jar')
  ];

  let source = null;
  for (const candidate of targets) {
    if (isValidModJar(candidate)) {
      source = candidate;
      break;
    }
  }

  if (!source) {
    source = findBloodpactJarInTree(bloodpactRoot, 3)
      || findBloodpactJarInTree(launcherDir, 2);
  }

  if (!source) {
    return null;
  }

  for (const target of targets) {
    if (isValidModJar(target)) {
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  return source;
}

function findLocalBloodPactJar(bloodpactRoot, modDef, launcherDir) {
  repairBloodpactJarLayout(bloodpactRoot, launcherDir);

  const searchRoots = [];
  if (bloodpactRoot) {
    searchRoots.push(bloodpactRoot);
  }
  if (launcherDir && launcherDir !== bloodpactRoot) {
    searchRoots.push(launcherDir);
  }

  for (const relative of modDef.localPaths || []) {
    for (const root of searchRoots) {
      const candidate = path.resolve(root, relative);
      if (isValidModJar(candidate)) {
        return candidate;
      }
    }
  }

  for (const root of searchRoots) {
    for (const subdir of [
      'bundled-mods',
      path.join('launcher', 'bundled-mods'),
      path.join('modern', 'build', 'libs'),
      path.join('build', 'libs')
    ]) {
      const found = findBloodpactJarInDir(path.join(root, subdir));
      if (found) {
        return found;
      }
    }
  }

  if (bloodpactRoot) {
    const cached = findBloodpactJarInTree(path.join(bloodpactRoot, 'mod-cache'), 2);
    if (cached) {
      return cached;
    }
  }

  return null;
}

function findExistingModByHint(modsDir, hint) {
  if (!hint || !fs.existsSync(modsDir)) {
    return null;
  }
  const match = fs.readdirSync(modsDir).find((name) =>
    name.toLowerCase().includes(hint.toLowerCase()) && name.endsWith('.jar')
  );
  return match ? path.join(modsDir, match) : null;
}

function modCachePath(cacheDir, modId, gameVersion) {
  return path.join(cacheDir, `${modId}-${gameVersion}.jar`);
}

function quarantineDirFor(launcherRoot, profileId) {
  return path.join(launcherRoot, 'quarantine', 'mods', profileId);
}

function getActiveContext(launcherRoot, minecraftDir) {
  const config = readJson(path.join(launcherRoot, 'config.json'), {});
  const resolved = resolveProfile(config, launcherRoot);
  const profileId = resolved.id;
  const modpack = resolved.modpack;
  return {
    config,
    profileId,
    profile: resolved,
    modpack,
    gameVersion: modpack.minecraftVersion || '1.21',
    loader: modpack.loader || 'fabric',
    modsDir: instanceModsDir(minecraftDir, profileId),
    enabledMods: resolved.enabledMods || {}
  };
}

function getModpackContext(launcherRoot) {
  const config = readJson(path.join(launcherRoot, 'config.json'), {});
  const resolved = resolveProfile(config, launcherRoot);
  return {
    gameVersion: resolved.modpack.minecraftVersion || '1.21',
    loader: resolved.modpack.loader || 'fabric',
    profileId: resolved.id
  };
}

function quarantineUnmanagedMods(modsDir, quarantineRoot, allowedFilenames) {
  fs.mkdirSync(quarantineRoot, { recursive: true });
  const allowed = new Set(allowedFilenames.map((name) => name.toLowerCase()));

  for (const file of fs.readdirSync(modsDir)) {
    if (!file.endsWith('.jar')) {
      continue;
    }
    if (allowed.has(file.toLowerCase())) {
      continue;
    }

    const source = path.join(modsDir, file);
    let destination = path.join(quarantineRoot, file);
    if (fs.existsSync(destination)) {
      destination = path.join(quarantineRoot, `${Date.now()}-${file}`);
    }
    fs.renameSync(source, destination);
  }
}

async function searchModrinth(query, options = {}) {
  const launcherRoot = options.launcherRoot;
  const { gameVersion, loader } = getModpackContext(launcherRoot);
  const facets = [
    ['project_type:mod'],
    [`versions:${gameVersion}`]
  ];
  if (loader && loader !== 'vanilla') {
    facets.push([`categories:${loader}`]);
  }
  const params = new URLSearchParams({
    query: query.trim() || ' ',
    limit: String(options.limit || 20),
    index: options.index || 'relevance',
    facets: JSON.stringify(facets)
  });
  const data = await fetchJson(`${MODRINTH_API}/search?${params.toString()}`, { label: 'Modrinth' });
  return {
    source: 'modrinth',
    hits: (data.hits || []).map((hit) => normalizeModrinthHit(hit)),
    total: data.total_hits || 0,
    gameVersion,
    loader
  };
}

function normalizeModrinthHit(hit) {
  return {
    source: 'modrinth',
    id: hit.project_id,
    projectId: hit.project_id,
    slug: hit.slug,
    name: hit.title,
    author: hit.author || (hit.display_categories || [])[0] || 'Unknown',
    description: hit.description || '',
    iconUrl: hit.icon_url || '',
    downloads: hit.downloads || 0,
    url: `https://modrinth.com/mod/${hit.slug}`
  };
}

async function searchCurseForge(query, options = {}) {
  const launcherRoot = options.launcherRoot;
  const apiKey = getCurseForgeApiKey(launcherRoot);
  if (!apiKey) {
    const modrinth = await searchModrinth(query, { ...options, launcherRoot });
    return {
      ...modrinth,
      source: 'curseforge',
      fallbackSource: 'modrinth',
      notice: 'CurseForge API key not set — showing matching Modrinth mods instead. Add a key in Settings for true CurseForge results.'
    };
  }

  const { gameVersion, loader } = getModpackContext(launcherRoot);
  const params = new URLSearchParams({
    gameId: String(MINECRAFT_GAME_ID),
    classId: String(MOD_CLASS_ID),
    searchFilter: query.trim() || ' ',
    pageSize: String(options.limit || 20),
    sortField: '2',
    sortOrder: 'desc'
  });

  if (gameVersion) {
    params.set('gameVersion', gameVersion);
  }

  const loaderType = MOD_LOADER_TYPES[loader];
  if (loaderType && loader !== 'vanilla') {
    params.set('modLoaderType', String(loaderType));
  }

  const data = await fetchJson(`${CURSEFORGE_API}/mods/search?${params.toString()}`, {
    label: 'CurseForge',
    headers: { 'x-api-key': apiKey }
  });

  const hits = (data.data || []).map((mod) => ({
    source: 'curseforge',
    id: String(mod.id),
    curseforgeModId: mod.id,
    slug: mod.slug,
    name: mod.name,
    author: mod.authors?.[0]?.name || 'Unknown',
    description: mod.summary || '',
    iconUrl: mod.logo?.thumbnailUrl || mod.logo?.url || '',
    downloads: mod.downloadCount || 0,
    url: mod.links?.websiteUrl || `https://www.curseforge.com/minecraft/mc-mods/${mod.slug}`
  }));

  return {
    source: 'curseforge',
    hits,
    total: data.pagination?.totalCount || hits.length,
    gameVersion,
    loader
  };
}

async function searchFreeMods(options = {}) {
  const launcherRoot = options.launcherRoot;
  const { gameVersion, loader } = getModpackContext(launcherRoot);
  const catalog = loadFreeModsCatalog(launcherRoot);
  const query = (options.query || '').trim().toLowerCase();

  let mods = catalog.mods || [];
  if (loader && loader !== 'vanilla') {
    mods = mods.filter((mod) => !mod.loaders?.length || mod.loaders.includes(loader));
  }

  if (query) {
    mods = mods.filter((mod) =>
      mod.name.toLowerCase().includes(query)
      || (mod.description || '').toLowerCase().includes(query)
      || (mod.category || '').toLowerCase().includes(query)
    );
  }

  const hits = mods.slice(0, options.limit || 40).map((mod) => ({
    source: 'free',
    id: mod.id,
    catalogId: mod.id,
    name: mod.name,
    author: catalog.categories?.[mod.category] || 'Free pick',
    description: mod.description || '',
    iconUrl: '',
    downloads: 0,
    url: mod.source === 'modrinth'
      ? `https://modrinth.com/mod/${mod.projectId}`
      : mod.url || '',
    installSource: mod.source,
    projectId: mod.projectId,
    curseforgeModId: mod.curseforgeModId,
    category: mod.category
  }));

  return {
    source: 'free',
    hits,
    total: hits.length,
    gameVersion,
    loader,
    categories: catalog.categories || {}
  };
}

async function searchMods(source, query, options = {}) {
  const normalized = String(source || 'modrinth').toLowerCase();
  const launcherRoot = options.launcherRoot;

  if (normalized === 'curseforge') {
    return searchCurseForge(query, { ...options, launcherRoot });
  }
  if (normalized === 'free') {
    return searchFreeMods({ ...options, launcherRoot, query });
  }
  return searchModrinth(query, { ...options, launcherRoot });
}

async function getModrinthProject(projectIdOrSlug) {
  const project = await fetchJson(`${MODRINTH_API}/project/${projectIdOrSlug}`);
  return {
    projectId: project.id,
    slug: project.slug,
    name: project.title,
    description: project.description || '',
    iconUrl: project.icon_url || '',
    downloads: project.downloads || 0,
    url: `https://modrinth.com/mod/${project.slug}`
  };
}

function customModId(source, rawId) {
  const prefix = source === 'curseforge' ? 'cf' : source === 'free' ? 'free' : 'mr';
  return `${prefix}-${rawId}`;
}

async function getCurseForgeMod(modId, launcherRoot) {
  const apiKey = getCurseForgeApiKey(launcherRoot);
  if (!apiKey) {
    throw new Error('CurseForge API key is missing. Add it in Settings.');
  }

  const data = await fetchJson(`${CURSEFORGE_API}/mods/${modId}`, {
    label: 'CurseForge',
    headers: { 'x-api-key': apiKey }
  });
  const mod = data.data;
  return {
    curseforgeModId: mod.id,
    slug: mod.slug,
    name: mod.name,
    description: mod.summary || '',
    iconUrl: mod.logo?.thumbnailUrl || mod.logo?.url || '',
    downloads: mod.downloadCount || 0,
    url: mod.links?.websiteUrl || `https://www.curseforge.com/minecraft/mc-mods/${mod.slug}`
  };
}

async function resolveCurseForgeFile(modId, gameVersion, loader = 'fabric', launcherRoot) {
  const apiKey = getCurseForgeApiKey(launcherRoot);
  if (!apiKey) {
    throw new Error('CurseForge API key is missing. Add it in Settings.');
  }

  const params = new URLSearchParams({
    pageSize: '1'
  });
  if (gameVersion) {
    params.set('gameVersion', gameVersion);
  }
  const loaderType = MOD_LOADER_TYPES[loader];
  if (loaderType && loader !== 'vanilla') {
    params.set('modLoaderType', String(loaderType));
  }

  const data = await fetchJson(`${CURSEFORGE_API}/mods/${modId}/files?${params.toString()}`, {
    label: 'CurseForge',
    headers: { 'x-api-key': apiKey }
  });

  const file = (data.data || [])[0];
  if (!file) {
    throw new Error(`No CurseForge file for mod ${modId} on ${gameVersion}`);
  }

  const downloadData = await fetchJson(`${CURSEFORGE_API}/mods/${modId}/files/${file.id}/download-url`, {
    label: 'CurseForge',
    headers: { 'x-api-key': apiKey }
  });

  return {
    id: file.id,
    filename: file.fileName,
    url: downloadData.data,
    version: file.displayName || String(file.id)
  };
}

async function downloadCurseForgeToMods(modId, context) {
  const { modsDir, gameVersion, loader, launcherRoot } = context;
  const file = await resolveCurseForgeFile(modId, gameVersion, loader, launcherRoot);
  fs.mkdirSync(modsDir, { recursive: true });
  const destination = path.join(modsDir, file.filename);
  await downloadFile(file.url, destination);
  return {
    filename: file.filename,
    version: file.version,
    versionId: String(file.id)
  };
}

async function downloadModrinthToMods(projectId, context) {
  const { modsDir, gameVersion, loader } = context;
  const version = await resolveModrinthVersion(projectId, gameVersion, loader);
  return downloadModrinthVersionToMods(version, modsDir);
}

async function downloadModrinthVersionToMods(version, modsDir) {
  const primaryFile = version.files.find((file) => file.primary) || version.files[0];
  if (!primaryFile) {
    throw new Error('This project has no downloadable file for your Minecraft version');
  }

  fs.mkdirSync(modsDir, { recursive: true });
  const destination = path.join(modsDir, primaryFile.filename);
  await downloadFile(primaryFile.url, destination);
  return {
    filename: primaryFile.filename,
    version: version.version_number,
    versionId: version.id,
    resolvedVersion: version
  };
}

function getModrinthRequiredDependencies(version) {
  return (version.dependencies || [])
    .filter((dep) => dep.dependency_type === 'required' && dep.project_id)
    .map((dep) => ({
      source: 'modrinth',
      projectId: dep.project_id,
      versionId: dep.version_id || null
    }));
}

function getCurseForgeRequiredDependencies(file) {
  return (file.dependencies || [])
    .filter((dep) => CURSEFORGE_REQUIRED_RELATIONS.has(dep.relationType) && dep.modId)
    .map((dep) => ({
      source: 'curseforge',
      modId: dep.modId
    }));
}

function createInstallContext(launcherRoot, minecraftDir, profileId) {
  const config = readJson(path.join(launcherRoot, 'config.json'), {});
  const modpack = loadModpack(launcherRoot, profileId) || resolveProfile(config, launcherRoot).modpack;
  const profile = config.profiles?.[profileId] || {};
  const enabledMods = profile.enabledMods || {};
  const customMods = readProfileCustomMods(launcherRoot, profileId).mods || [];

  const modpackModsByProjectId = new Map();
  for (const mod of modpack?.mods || []) {
    if (mod.source === 'modrinth' && mod.projectId) {
      modpackModsByProjectId.set(mod.projectId, mod);
    }
  }

  const customModrinthIds = new Set(
    customMods.filter((mod) => mod.enabled && mod.projectId).map((mod) => mod.projectId)
  );
  const customCurseForgeIds = new Set(
    customMods
      .filter((mod) => mod.enabled && mod.curseforgeModId)
      .map((mod) => String(mod.curseforgeModId))
  );

  return {
    launcherRoot,
    minecraftDir,
    profileId,
    modpack,
    modpackModsByProjectId,
    customModrinthIds,
    customCurseForgeIds,
    installingModrinth: new Set(),
    installingCurseForge: new Set(),
    installed: []
  };
}

function findModpackModByProjectId(ctx, projectId) {
  return ctx.modpackModsByProjectId.get(projectId) || null;
}

function listJarFiles(modsDir) {
  if (!modsDir || !fs.existsSync(modsDir)) {
    return [];
  }
  return fs.readdirSync(modsDir).filter((name) => name.endsWith('.jar'));
}

function jarMatchesHint(jarName, hint) {
  if (!hint) {
    return false;
  }
  return jarName.toLowerCase().includes(String(hint).toLowerCase());
}

const MOD_CONFLICT_RULES = [
  {
    reason: 'Iris breaks Sodium rendering on Minecraft 26.x',
    whenEnabledHints: ['sodium'],
    removeHints: ['iris']
  }
];

function applyModConflictCleanup(modsDir, quarantineRoot, enabledMods, modpack) {
  if (!fs.existsSync(modsDir)) {
    return [];
  }

  const enabledHints = [];
  for (const modDef of modpack.mods || []) {
    if (!isModEnabled(modDef, enabledMods, modpack)) {
      continue;
    }
    enabledHints.push(modDef.id);
    if (modDef.fallbackFilename) {
      enabledHints.push(modDef.fallbackFilename);
    }
  }

  const removed = [];
  for (const rule of MOD_CONFLICT_RULES) {
    const ruleActive = rule.whenEnabledHints.some((hint) =>
      enabledHints.some((enabledHint) => jarMatchesHint(enabledHint, hint))
    );
    if (!ruleActive) {
      continue;
    }

    for (const file of listJarFiles(modsDir)) {
      if (!rule.removeHints.some((hint) => jarMatchesHint(file, hint))) {
        continue;
      }
      const source = path.join(modsDir, file);
      fs.mkdirSync(quarantineRoot, { recursive: true });
      let destination = path.join(quarantineRoot, file);
      if (fs.existsSync(destination)) {
        destination = path.join(quarantineRoot, `${Date.now()}-${file}`);
      }
      fs.renameSync(source, destination);
      removed.push({ file, reason: rule.reason });
    }
  }

  return removed;
}

function isModrinthJarOnDisk(projectId, ctx, runtime) {
  if (!runtime?.modsDir) {
    return false;
  }

  const modpackMod = findModpackModByProjectId(ctx, projectId);
  if (modpackMod) {
    const packJar = path.join(runtime.modsDir, `${modpackMod.id}.jar`);
    if (fs.existsSync(packJar)) {
      return true;
    }
    if (modpackMod.fallbackFilename) {
      if (listJarFiles(runtime.modsDir).some((name) => jarMatchesHint(name, modpackMod.fallbackFilename))) {
        return true;
      }
    }
  }

  const store = readProfileCustomMods(ctx.launcherRoot, ctx.profileId);
  const customMod = store.mods.find((mod) => mod.enabled && mod.projectId === projectId);
  if (customMod?.filename && fs.existsSync(path.join(runtime.modsDir, customMod.filename))) {
    return true;
  }

  return false;
}

function isModrinthProjectSatisfied(projectId, ctx, runtime) {
  return isModrinthJarOnDisk(projectId, ctx, runtime);
}

function deployModpackJarAlias(modsDir, modpackMod, downloadedFilename) {
  if (!modpackMod || !downloadedFilename) {
    return;
  }

  const source = path.join(modsDir, downloadedFilename);
  const target = path.join(modsDir, `${modpackMod.id}.jar`);
  if (fs.existsSync(source) && !fs.existsSync(target)) {
    fs.copyFileSync(source, target);
  }
}

async function findModrinthProjectByName(name) {
  const params = new URLSearchParams({
    query: name,
    limit: '5',
    index: 'relevance',
    facets: JSON.stringify([['project_type:mod']])
  });
  const data = await fetchJson(`${MODRINTH_API}/search?${params.toString()}`, { label: 'Modrinth' });
  const normalized = name.trim().toLowerCase();
  const hit = (data.hits || []).find((entry) => entry.title?.trim().toLowerCase() === normalized)
    || (data.hits || [])[0];
  if (!hit) {
    return null;
  }
  return normalizeModrinthHit(hit);
}

async function ensureLoaderDependencies(ctx, runtime) {
  const results = [];
  if (runtime.loader === 'fabric' || runtime.loader === 'quilt') {
    const fabricApi = await installModrinthProjectWithDependencies(FABRIC_API_MODRINTH_ID, ctx, runtime, {
      isDependency: true
    });
    if (fabricApi) {
      results.push(fabricApi);
    }
  }
  return results;
}

async function lookupModrinthVersionByFile(filePath) {
  for (const algorithm of ['sha512', 'sha1']) {
    try {
      const hashes = [hashFile(filePath, algorithm)];
      const data = await fetchJsonPost(`${MODRINTH_API}/version_files`, {
        hashes,
        algorithm
      }, { label: 'Modrinth' });
      const version = data[hashes[0]];
      if (version?.project_id) {
        return version;
      }
    } catch {
      // Try the next hash algorithm.
    }
  }
  return null;
}

async function ensureModrinthDependencyTree(projectId, ctx, runtime, results = []) {
  const installResult = await installModrinthProjectWithDependencies(projectId, ctx, runtime, {
    isDependency: true
  });
  if (!installResult) {
    return results;
  }

  for (const depName of flattenDependencyNames(installResult)) {
    results.push({
      name: depName,
      status: 'dependency',
      source: 'modrinth'
    });
  }

  return results;
}

async function ensureDependenciesForLocalJars(ctx, runtime) {
  const results = [];
  for (const jarName of listJarFiles(runtime.modsDir)) {
    const filePath = path.join(runtime.modsDir, jarName);
    let version;
    try {
      version = await lookupModrinthVersionByFile(filePath);
    } catch {
      continue;
    }
    if (!version?.project_id) {
      continue;
    }

    results.push({
      name: jarName,
      status: 'scanned',
      source: 'local-jar'
    });

    try {
      const tree = await ensureModrinthDependencyTree(version.project_id, ctx, runtime, []);
      results.push(...tree);
    } catch (error) {
      results.push({
        name: jarName,
        status: 'error',
        source: 'local-jar',
        error: error.message
      });
    }
  }
  return results;
}

function recordInstallResult(results, installResult, fallbackName, source) {
  if (!installResult) {
    results.push({ name: fallbackName, status: 'present', source });
    return;
  }

  for (const depName of flattenDependencyNames(installResult)) {
    results.push({ name: depName, status: 'dependency', source });
  }

  results.push({
    name: installResult.mod?.name || fallbackName,
    status: installResult.alreadyPresent ? 'present' : 'downloaded',
    source
  });
}

async function ensureProfileDependencies(launcherRoot, minecraftDir, profileId, options = {}) {
  const skipModpackMods = options.skipModpackMods === true;
  const skipLocalJarScan = options.skipLocalJarScan === true;
  const { gameVersion, loader, modsDir } = getActiveContext(launcherRoot, minecraftDir);
  const ctx = createInstallContext(launcherRoot, minecraftDir, profileId);
  const runtime = { modsDir, gameVersion, loader };
  const config = readJson(path.join(launcherRoot, 'config.json'), {});
  const enabledMods = config.profiles?.[profileId]?.enabledMods || {};
  const results = [];

  if (!skipModpackMods) {
    try {
      for (const installed of await ensureLoaderDependencies(ctx, runtime)) {
        recordInstallResult(results, installed, 'Fabric API', 'loader');
      }
    } catch (error) {
      results.push({
        name: 'Loader dependencies',
        status: 'error',
        source: 'loader',
        error: error.message
      });
    }
  }

  if (!skipModpackMods) {
    for (const modDef of ctx.modpack?.mods || []) {
      const enabled = isModEnabled(modDef, enabledMods, ctx.modpack);
      if (!enabled) {
        continue;
      }

      try {
        if (modDef.source === 'curseforge' && modDef.curseforgeModId) {
          const installResult = await installCurseForgeModWithDependencies(modDef.curseforgeModId, ctx, runtime, {
            isDependency: false
          });
          recordInstallResult(results, installResult, modDef.name, 'curseforge');
        } else if (modDef.source === 'modrinth' && modDef.projectId) {
          const installResult = await installModrinthProjectWithDependencies(modDef.projectId, ctx, runtime, {
            isDependency: false
          });
          recordInstallResult(results, installResult, modDef.name, 'modpack');
        }
      } catch (error) {
        results.push({ name: modDef.name, status: 'error', source: 'modpack', error: error.message });
      }
    }
  }

  for (const mod of readProfileCustomMods(launcherRoot, profileId).mods) {
    if (!mod.enabled) {
      results.push({ id: mod.id, status: 'disabled', name: mod.name });
      continue;
    }

    try {
      if (mod.source === 'curseforge' && mod.curseforgeModId) {
        const installResult = await installCurseForgeModWithDependencies(mod.curseforgeModId, ctx, runtime, {
          isDependency: Boolean(mod.isDependency)
        });
        recordInstallResult(results, installResult, mod.name, 'curseforge');
        results[results.length - 1].id = mod.id;
      } else if (mod.projectId) {
        const installResult = await installModrinthProjectWithDependencies(mod.projectId, ctx, runtime, {
          isDependency: Boolean(mod.isDependency)
        });
        recordInstallResult(results, installResult, mod.name, 'modrinth');
        results[results.length - 1].id = mod.id;
      } else {
        throw new Error('Mod entry is missing download source info');
      }
    } catch (error) {
      results.push({ id: mod.id, status: 'error', name: mod.name, error: error.message });
    }
  }

  if (!skipLocalJarScan) {
    try {
      results.push(...await ensureDependenciesForLocalJars(ctx, runtime));
    } catch (error) {
      results.push({
        name: 'Local jar dependencies',
        status: 'error',
        source: 'local-jar',
        error: error.message
      });
    }
  }
  return results;
}

function isCurseForgeModSatisfied(modId, ctx, runtime) {
  const store = readProfileCustomMods(ctx.launcherRoot, ctx.profileId);
  const customMod = store.mods.find(
    (mod) => mod.enabled && String(mod.curseforgeModId) === String(modId)
  );
  if (!customMod) {
    return false;
  }

  if (!runtime?.modsDir || !customMod.filename) {
    return true;
  }

  return fs.existsSync(path.join(runtime.modsDir, customMod.filename));
}

function upsertCustomModEntry(launcherRoot, profileId, entry) {
  const store = readProfileCustomMods(launcherRoot, profileId);
  store.mods = store.mods.filter((mod) => mod.id !== entry.id);
  store.mods.push(entry);
  writeProfileCustomMods(launcherRoot, profileId, store);
  return entry;
}

async function installModrinthProjectWithDependencies(projectIdOrSlug, ctx, runtime, options = {}) {
  const quickProjectId = String(projectIdOrSlug || '');
  if (!options.forceRefresh && /^[A-Za-z0-9]{6,12}$/.test(quickProjectId)) {
    if (isModrinthJarOnDisk(quickProjectId, ctx, runtime)) {
      return null;
    }
  }

  const project = await getModrinthProject(projectIdOrSlug);
  const projectId = project.projectId;

  if (ctx.installingModrinth.has(projectId)) {
    return null;
  }

  ctx.installingModrinth.add(projectId);
  try {
    const version = await resolveModrinthVersion(projectId, runtime.gameVersion, runtime.loader);
    const dependencyResults = [];

    for (const dep of getModrinthRequiredDependencies(version)) {
      const depResult = await installModrinthProjectWithDependencies(dep.projectId, ctx, runtime, {
        isDependency: true
      });
      if (depResult) {
        dependencyResults.push(depResult);
      }
    }

    if (isModrinthJarOnDisk(projectId, ctx, runtime)) {
      if (!dependencyResults.length) {
        return null;
      }
      return {
        mod: { name: project.name, projectId: project.projectId },
        dependencies: dependencyResults,
        isDependency: Boolean(options.isDependency),
        alreadyPresent: true
      };
    }

    const download = await downloadModrinthVersionToMods(version, runtime.modsDir);
    const modpackMod = findModpackModByProjectId(ctx, projectId);
    deployModpackJarAlias(runtime.modsDir, modpackMod, download.filename);

    const store = readProfileCustomMods(ctx.launcherRoot, ctx.profileId);
    const existing = store.mods.find((mod) => mod.projectId === project.projectId);
    const shouldTrackInCustomMods = !modpackMod || !options.isDependency;

    let entry;
    if (shouldTrackInCustomMods) {
      const id = customModId('modrinth', project.projectId);
      entry = upsertCustomModEntry(ctx.launcherRoot, ctx.profileId, {
        id,
        source: 'modrinth',
        projectId: project.projectId,
        slug: project.slug,
        name: project.name,
        description: project.description,
        iconUrl: project.iconUrl,
        url: project.url,
        filename: download.filename,
        version: download.version,
        enabled: true,
        isDependency: Boolean(options.isDependency),
        addedAt: existing?.addedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      ctx.customModrinthIds.add(project.projectId);
    } else {
      entry = {
        name: project.name,
        projectId: project.projectId,
        version: download.version,
        filename: modpackMod ? `${modpackMod.id}.jar` : download.filename,
        isDependency: true
      };
    }

    const result = {
      mod: entry,
      dependencies: dependencyResults,
      isDependency: Boolean(options.isDependency)
    };
    ctx.installed.push(result);
    return result;
  } finally {
    ctx.installingModrinth.delete(projectId);
  }
}

async function installCurseForgeModWithDependencies(modId, ctx, runtime, options = {}) {
  const normalizedId = String(modId);
  if (ctx.installingCurseForge.has(normalizedId)) {
    return null;
  }

  ctx.installingCurseForge.add(normalizedId);
  try {
    const file = await resolveCurseForgeFile(modId, runtime.gameVersion, runtime.loader, ctx.launcherRoot);
    const dependencyResults = [];

    for (const dep of getCurseForgeRequiredDependencies(file)) {
      let depResult = null;
      try {
        depResult = await installCurseForgeModWithDependencies(dep.modId, ctx, runtime, {
          isDependency: true
        });
      } catch (error) {
        depResult = await installCurseForgeDependencyViaModrinth(dep.modId, ctx, runtime, error);
      }
      if (depResult) {
        dependencyResults.push(depResult);
      }
    }

    if (isCurseForgeModSatisfied(modId, ctx, runtime)) {
      if (!dependencyResults.length) {
        return null;
      }
      const mod = await getCurseForgeMod(modId, ctx.launcherRoot);
      return {
        mod: { name: mod.name, curseforgeModId: mod.curseforgeModId },
        dependencies: dependencyResults,
        isDependency: Boolean(options.isDependency),
        alreadyPresent: true
      };
    }

    const mod = await getCurseForgeMod(modId, ctx.launcherRoot);
    fs.mkdirSync(runtime.modsDir, { recursive: true });
    const destination = path.join(runtime.modsDir, file.filename);
    await downloadFile(file.url, destination);

    const id = customModId('curseforge', mod.curseforgeModId);
    const store = readProfileCustomMods(ctx.launcherRoot, ctx.profileId);
    const existing = store.mods.find((entry) => String(entry.curseforgeModId) === String(mod.curseforgeModId));
    const entry = upsertCustomModEntry(ctx.launcherRoot, ctx.profileId, {
      id,
      source: 'curseforge',
      curseforgeModId: mod.curseforgeModId,
      slug: mod.slug,
      name: mod.name,
      description: mod.description,
      iconUrl: mod.iconUrl,
      url: mod.url,
      filename: file.filename,
      version: file.version,
      enabled: true,
      isDependency: Boolean(options.isDependency),
      addedAt: existing?.addedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    ctx.customCurseForgeIds.add(String(mod.curseforgeModId));
    const result = {
      mod: entry,
      dependencies: dependencyResults,
      isDependency: Boolean(options.isDependency)
    };
    ctx.installed.push(result);
    return result;
  } finally {
    ctx.installingCurseForge.delete(normalizedId);
  }
}

async function installCurseForgeDependencyViaModrinth(modId, ctx, runtime, originalError) {
  let modName = null;
  const apiKey = getCurseForgeApiKey(ctx.launcherRoot);
  if (apiKey) {
    try {
      const mod = await getCurseForgeMod(modId, ctx.launcherRoot);
      modName = mod.name;
    } catch {
      // Fall through to Modrinth name search below.
    }
  }

  if (!modName) {
    throw originalError;
  }

  const hit = await findModrinthProjectByName(modName);
  if (!hit?.projectId) {
    throw originalError;
  }

  return installModrinthProjectWithDependencies(hit.projectId, ctx, runtime, {
    isDependency: true
  });
}

async function installCustomMod(launcherRoot, source, idOrSlug) {
  const normalizedSource = String(source || 'modrinth').toLowerCase();
  const config = readJson(path.join(launcherRoot, 'config.json'), {});
  const minecraftDir = config.minecraftDir || path.resolve(launcherRoot, '..', '..');
  const { profileId, modsDir, gameVersion, loader } = getActiveContext(launcherRoot, minecraftDir);
  const runtime = { modsDir, gameVersion, loader };
  const ctx = createInstallContext(launcherRoot, minecraftDir, profileId);

  if (normalizedSource === 'free') {
    const catalog = loadFreeModsCatalog(launcherRoot);
    const entry = catalog.mods.find((mod) => mod.id === idOrSlug);
    if (!entry) {
      throw new Error(`Unknown free mod: ${idOrSlug}`);
    }
    return installCustomMod(launcherRoot, entry.source || 'modrinth', entry.projectId || entry.curseforgeModId);
  }

  if (normalizedSource === 'curseforge') {
    await ensureLoaderDependencies(ctx, runtime);
    const result = await installCurseForgeModWithDependencies(idOrSlug, ctx, runtime, { isDependency: false });
    if (!result) {
      const store = readProfileCustomMods(launcherRoot, profileId);
      const existing = store.mods.find((entry) => String(entry.curseforgeModId) === String(idOrSlug));
      if (existing) {
        return { ok: true, mod: existing, dependencies: [], modsDir, alreadyInstalled: true };
      }
      throw new Error('Could not install this CurseForge mod for your Minecraft version');
    }

    return {
      ok: true,
      mod: result.mod,
      dependencies: flattenDependencyNames(result),
      modsDir
    };
  }

  await ensureLoaderDependencies(ctx, runtime);
  const result = await installModrinthProjectWithDependencies(idOrSlug, ctx, runtime, { isDependency: false });
  if (!result) {
    const store = readProfileCustomMods(launcherRoot, profileId);
    let existing = store.mods.find((mod) => mod.projectId === idOrSlug || mod.slug === idOrSlug);
    if (!existing) {
      const project = await getModrinthProject(idOrSlug);
      existing = store.mods.find((mod) => mod.projectId === project.projectId);
    }
    if (existing) {
      return { ok: true, mod: existing, dependencies: [], modsDir, alreadyInstalled: true };
    }
    throw new Error('Could not install this mod for your Minecraft version');
  }

  return {
    ok: true,
    mod: result.mod,
    dependencies: flattenDependencyNames(result),
    modsDir
  };
}

function flattenDependencyNames(result) {
  const names = [];
  const walk = (entry) => {
    for (const dep of entry.dependencies || []) {
      if (dep?.mod?.name) {
        names.push(dep.mod.name);
        walk(dep);
      }
    }
  };
  walk(result);
  return [...new Set(names)];
}

async function removeCustomMod(launcherRoot, modId) {
  const config = readJson(path.join(launcherRoot, 'config.json'), {});
  const minecraftDir = config.minecraftDir || path.resolve(launcherRoot, '..', '..');
  const { profileId, modsDir } = getActiveContext(launcherRoot, minecraftDir);
  const store = readProfileCustomMods(launcherRoot, profileId);
  const target = store.mods.find((mod) => mod.id === modId);
  if (!target) {
    return { ok: false, error: 'Mod not found' };
  }

  const jarPath = path.join(modsDir, target.filename);
  if (fs.existsSync(jarPath)) {
    fs.unlinkSync(jarPath);
  }

  store.mods = store.mods.filter((mod) => mod.id !== modId);
  writeProfileCustomMods(launcherRoot, profileId, store);
  return { ok: true, removed: target };
}

function toggleCustomMod(launcherRoot, modId, enabled) {
  const config = readJson(path.join(launcherRoot, 'config.json'), {});
  const minecraftDir = config.minecraftDir || path.resolve(launcherRoot, '..', '..');
  const { profileId, modsDir } = getActiveContext(launcherRoot, minecraftDir);
  const store = readProfileCustomMods(launcherRoot, profileId);
  const target = store.mods.find((mod) => mod.id === modId);
  if (!target) {
    return { ok: false, error: 'Mod not found' };
  }

  target.enabled = enabled;
  writeProfileCustomMods(launcherRoot, profileId, store);

  const jarPath = path.join(modsDir, target.filename);

  if (!enabled && fs.existsSync(jarPath)) {
    fs.unlinkSync(jarPath);
  }

  return { ok: true, mod: target, needsSync: enabled && !fs.existsSync(jarPath) };
}

async function syncCustomMods(launcherRoot, minecraftDir, profileId, options = {}) {
  return ensureProfileDependencies(launcherRoot, minecraftDir, profileId, {
    skipModpackMods: true,
    skipLocalJarScan: options.skipLocalJarScan === true || options.fast === true
  });
}

function listCustomMods(launcherRoot, minecraftDir, profileId) {
  const store = readProfileCustomMods(launcherRoot, profileId);
  const modsDir = instanceModsDir(minecraftDir, profileId);
  return store.mods.map((mod) => ({
    ...mod,
    installed: fs.existsSync(path.join(modsDir, mod.filename))
  }));
}

function isCustomModInstalled(launcherRoot, source, id, profileId) {
  const mods = readProfileCustomMods(launcherRoot, profileId).mods;
  const normalized = String(source || 'modrinth').toLowerCase();

  if (normalized === 'curseforge') {
    return mods.some((mod) => mod.curseforgeModId === Number(id) || String(mod.curseforgeModId) === String(id));
  }
  if (normalized === 'free') {
    const catalog = loadFreeModsCatalog(launcherRoot);
    const entry = catalog.mods.find((mod) => mod.id === id);
    if (!entry) {
      return false;
    }
    if (entry.source === 'curseforge') {
      return mods.some((mod) => String(mod.curseforgeModId) === String(entry.curseforgeModId));
    }
    return mods.some((mod) => mod.projectId === entry.projectId);
  }

  return mods.some((mod) => mod.projectId === id);
}

async function resolveModrinthVersion(projectId, gameVersion, loader = 'fabric') {
  const url = `${MODRINTH_API}/project/${projectId}/version?game_versions=["${gameVersion}"]&loaders=["${loader}"]`;
  const versions = await fetchJson(url);
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error(`No Modrinth version for project ${projectId} on ${gameVersion}`);
  }
  return versions[0];
}

async function ensureMod(modDef, context) {
  const {
    launcherRoot,
    launcherDir,
    cacheDir,
    modsDir,
    gameVersion,
    loader = 'fabric',
    enabled
  } = context;

  if (!enabled && !modDef.required) {
    return { id: modDef.id, status: 'skipped', enabled: false };
  }

  if (modDef.source === 'local') {
    const cachePath = modCachePath(cacheDir, modDef.id, gameVersion);
    const localJar = findLocalBloodPactJar(launcherRoot, modDef, launcherDir);
    if (!localJar) {
      const staged = path.join(modsDir, `${modDef.id}.jar`);
      if (isValidModJar(staged)) {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.copyFileSync(staged, cachePath);
        return { id: modDef.id, status: 'local', enabled: true, sourcePath: staged, cachePath };
      }
      if (fs.existsSync(cachePath) && isValidModJar(cachePath)) {
        return { id: modDef.id, status: 'cached', enabled: true, cachePath };
      }
      return {
        id: modDef.id,
        status: 'missing',
        enabled: true,
        error: modDef.buildHint || 'Local mod jar not found'
      };
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.copyFileSync(localJar, cachePath);
    return { id: modDef.id, status: 'local', enabled: true, sourcePath: localJar, cachePath };
  }

  const cachePath = modCachePath(cacheDir, modDef.id, gameVersion);
  if (fs.existsSync(cachePath)) {
    return { id: modDef.id, status: 'cached', enabled: true, cachePath };
  }

  if (modDef.source === 'curseforge' && modDef.curseforgeModId) {
    const apiRoot = launcherDir || resolveLauncherDir(launcherRoot);
    if (!getCurseForgeApiKey(apiRoot)) {
      return {
        id: modDef.id,
        status: 'missing',
        enabled: true,
        error: 'CurseForge API key missing. Add one in launcher/share-pack.json before sharing, or in Settings.'
      };
    }

    const file = await resolveCurseForgeFile(modDef.curseforgeModId, gameVersion, loader, apiRoot);
    fs.mkdirSync(cacheDir, { recursive: true });
    await downloadFile(file.url, cachePath);
    return {
      id: modDef.id,
      status: 'downloaded',
      enabled: true,
      cachePath,
      version: file.version
    };
  }

  if (!modDef.projectId) {
    return {
      id: modDef.id,
      status: 'missing',
      enabled: true,
      error: 'Mod definition is missing projectId or curseforgeModId'
    };
  }

  const stagedJar = path.join(modsDir, `${modDef.id}.jar`);
  if (isValidModJar(stagedJar)) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.copyFileSync(stagedJar, cachePath);
    return { id: modDef.id, status: 'local', enabled: true, sourcePath: stagedJar, cachePath };
  }

  try {
    const version = await resolveModrinthVersion(modDef.projectId, gameVersion, loader);
    const primaryFile = version.files.find((file) => file.primary) || version.files[0];
    if (!primaryFile) {
      throw new Error(`Modrinth project ${modDef.id} has no downloadable file`);
    }

    fs.mkdirSync(cacheDir, { recursive: true });
    await downloadFile(primaryFile.url, cachePath);
    return {
      id: modDef.id,
      status: 'downloaded',
      enabled: true,
      cachePath,
      version: version.version_number
    };
  } catch (error) {
    if (fs.existsSync(cachePath) && isValidModJar(cachePath)) {
      return { id: modDef.id, status: 'cached', enabled: true, cachePath };
    }
    throw new Error(formatModNetworkError(error));
  }
}

async function syncMods(options) {
  const launcherRoot = options.launcherRoot;
  const bloodpactRoot = path.resolve(launcherRoot, '..');
  const configPath = path.join(launcherRoot, 'config.json');
  const config = readJson(configPath, {});
  const modpacks = listModpacks(launcherRoot);
  enforceEssentialMods(config, modpacks);
  writeJson(configPath, config);
  const minecraftDir = options.minecraftDir || path.resolve(bloodpactRoot, '..');
  const active = getActiveContext(launcherRoot, minecraftDir);
  const modpack = active.modpack;
  const profileId = active.profileId;
  const enabledMods = active.enabledMods;
  const fast = options.fast === true;

  const modsDir = active.modsDir;
  const cacheDir = path.join(bloodpactRoot, 'mod-cache', profileId);
  const stagingDir = path.join(bloodpactRoot, 'instance-staging', profileId, 'mods');

  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(modsDir, { recursive: true });

  if (fast && canUseFastSync(launcherRoot, profileId, modpack, enabledMods, modsDir, cacheDir)) {
    const quarantineRoot = quarantineDirFor(launcherRoot, profileId);
    const conflictRemovals = applyModConflictCleanup(modsDir, quarantineRoot, enabledMods, modpack);
    const allowedFilenames = collectAllowedFilenames(launcherRoot, profileId, modpack, enabledMods, modsDir);
    quarantineUnmanagedMods(modsDir, quarantineRoot, allowedFilenames);
    return {
      results: [],
      customResults: [],
      dependencyResults: [],
      conflictRemovals,
      localMods: scanLocalMods(modsDir),
      stagingDir,
      modsDir,
      minecraftDir,
      profileId,
      modpackId: modpack.id,
      gameVersion: modpack.minecraftVersion,
      fastPath: true
    };
  }

  const results = [];

  for (const modDef of modpack.mods || []) {
    const enabled = isModEnabled(modDef, enabledMods, modpack);
    try {
      const result = await ensureMod(modDef, {
        launcherRoot: bloodpactRoot,
        launcherDir: launcherRoot,
        cacheDir,
        modsDir,
        gameVersion: modpack.minecraftVersion,
        loader: modpack.loader || 'fabric',
        enabled
      });
      results.push(result);

      if (result.cachePath && fs.existsSync(result.cachePath) && enabled) {
        const target = path.join(stagingDir, `${modDef.id}.jar`);
        copyFileIfChanged(result.cachePath, target);
      }
    } catch (error) {
      results.push({
        id: modDef.id,
        status: 'error',
        enabled,
        error: error.message
      });
    }
  }

  deployStagingToMods(stagingDir, modsDir, modpack, enabledMods);
  const customResults = await syncCustomMods(launcherRoot, minecraftDir, profileId, {
    fast,
    skipLocalJarScan: fast
  });
  const dependencyResults = customResults.filter((entry) => entry.status === 'dependency');

  const allowedFilenames = collectAllowedFilenames(launcherRoot, profileId, modpack, enabledMods, modsDir);
  const quarantineRoot = quarantineDirFor(launcherRoot, profileId);
  const conflictRemovals = applyModConflictCleanup(modsDir, quarantineRoot, enabledMods, modpack);
  quarantineUnmanagedMods(modsDir, quarantineRoot, allowedFilenames);
  writeSyncState(cacheDir, buildSyncFingerprint(launcherRoot, profileId, modpack, enabledMods, modsDir));

  return {
    results,
    customResults,
    dependencyResults,
    conflictRemovals,
    localMods: scanLocalMods(modsDir),
    stagingDir,
    modsDir,
    minecraftDir,
    profileId,
    modpackId: modpack.id,
    gameVersion: modpack.minecraftVersion
  };
}

function collectAllowedFilenames(launcherRoot, profileId, modpack, enabledMods, modsDir) {
  const allowedFilenames = [];
  for (const modDef of modpack.mods || []) {
    const enabled = isModEnabled(modDef, enabledMods, modpack);
    if (enabled) {
      allowedFilenames.push(`${modDef.id}.jar`);
    }
  }
  for (const mod of readProfileCustomMods(launcherRoot, profileId).mods) {
    if (mod.enabled && mod.filename) {
      allowedFilenames.push(mod.filename);
    }
  }
  for (const modDef of modpack.mods || []) {
    const enabled = isModEnabled(modDef, enabledMods, modpack);
    if (!enabled || !modDef.fallbackFilename) {
      continue;
    }
    for (const file of listJarFiles(modsDir)) {
      if (jarMatchesHint(file, modDef.fallbackFilename)) {
        allowedFilenames.push(file);
      }
    }
  }
  return allowedFilenames;
}

function deployStagingToMods(stagingDir, modsDir, modpack, enabledMods) {
  const managedIds = new Set(modpack.mods.map((mod) => mod.id));
  const existingJars = listJarFiles(modsDir);

  for (const modDef of modpack.mods) {
    const enabled = isModEnabled(modDef, enabledMods, modpack);
    const staged = path.join(stagingDir, `${modDef.id}.jar`);
    const target = path.join(modsDir, `${modDef.id}.jar`);
    const hints = [modDef.id, modDef.fallbackFilename].filter(Boolean);

    for (const file of existingJars) {
      if (file === `${modDef.id}.jar`) {
        continue;
      }
      const lower = file.toLowerCase();
      if (hints.some((hint) => lower.includes(String(hint).toLowerCase()))) {
        fs.unlinkSync(path.join(modsDir, file));
      }
    }

    if (enabled && fs.existsSync(staged)) {
      copyFileIfChanged(staged, target);
    } else if (!enabled && fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  }

  return managedIds;
}

function getModCatalog(launcherRoot) {
  const config = readJson(path.join(launcherRoot, 'config.json'), {});
  const modpacks = listModpacks(launcherRoot);
  enforceEssentialMods(config, modpacks);
  const resolved = resolveProfile(config, launcherRoot);
  const modpack = resolved.modpack;
  const enabledMods = resolved.enabledMods || {};

  return {
    modpack,
    profile: resolved,
    mods: (modpack.mods || []).map((mod) => ({
      ...mod,
      locked: isModLocked(mod, modpack),
      enabled: isModEnabled(mod, enabledMods, modpack)
    }))
  };
}

function updateModToggle(launcherRoot, modId, enabled) {
  const configPath = path.join(launcherRoot, 'config.json');
  const config = readJson(configPath, {});
  const profileKey = getSelectedProfileId(config);
  const modpack = resolveProfile(config, launcherRoot).modpack;
  const modDef = (modpack.mods || []).find((mod) => mod.id === modId);
  if (modDef && isModLocked(modDef, modpack)) {
    enabled = true;
  }
  config.profiles = config.profiles || {};
  config.profiles[profileKey] = config.profiles[profileKey] || { enabledMods: {} };
  config.profiles[profileKey].enabledMods = config.profiles[profileKey].enabledMods || {};
  config.profiles[profileKey].enabledMods[modId] = enabled;
  enforceEssentialMods(config, listModpacks(launcherRoot));
  writeJson(configPath, config);
  return config;
}

function selectProfile(launcherRoot, profileId) {
  const configPath = path.join(launcherRoot, 'config.json');
  const config = readJson(configPath, {});
  const modpacks = listModpacks(launcherRoot);
  if (!modpacks.some((pack) => pack.id === profileId)) {
    throw new Error(`Unknown profile: ${profileId}`);
  }
  config.selectedProfile = profileId;
  writeJson(configPath, config);
  return config;
}

module.exports = {
  readJson,
  writeJson,
  parseJsonString,
  stripJsonBom,
  scanLocalMods,
  syncMods,
  getModCatalog,
  updateModToggle,
  selectProfile,
  searchModrinth,
  searchCurseForge,
  searchFreeMods,
  searchMods,
  installCustomMod,
  removeCustomMod,
  toggleCustomMod,
  listCustomMods,
  isCustomModInstalled,
  getActiveContext,
  getCurseForgeApiKey,
  ensureProfileDependencies
};
