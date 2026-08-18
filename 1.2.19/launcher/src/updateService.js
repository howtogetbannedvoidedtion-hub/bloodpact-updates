const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { readJson, writeJson, parseJsonString } = require('./modManager');
const { getBloodpactRoot } = require('./bundledRuntime');
const { formatNetworkError } = require('./launcherService');

const USER_AGENT = 'BloodPact-Launcher/1.0.0 (cloud-update)';

const UPDATABLE_PREFIXES = [
  'bundled-mods/',
  'launcher/src/',
  'launcher/ui/',
  'launcher/modpacks/',
  'launcher/free-mods/',
  'launcher/op-seeds/',
  'launcher/assets/',
  'launcher/bootstrap.js',
  'launcher/preload.js',
  'launcher/package.json',
  'launcher/share-pack.json',
  '2-Open-BloodPact.bat',
  'BloodPact.bat',
  'READ-ME-FIRST.txt',
  'DISCORD-SHARE-MESSAGE.txt'
];

function normalizeRelPath(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function isUpdatablePath(relPath) {
  const normalized = normalizeRelPath(relPath);
  return UPDATABLE_PREFIXES.some((prefix) =>
    normalized === prefix.replace(/\/$/, '') || normalized.startsWith(prefix)
  );
}

function isPlaceholderUpdateUrl(url) {
  const normalized = String(url || '').trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return /your-link-here|your-user|example\.com|placeholder|replace-me|changeme|todo/i.test(normalized);
}

function getUpdateManifestUrl(launcherRoot) {
  const sharePack = readJson(path.join(launcherRoot, 'share-pack.json'), {});
  const config = readJson(path.join(launcherRoot, 'config.json'), {});
  const candidate = (
    config.updateManifestUrl
    || sharePack.updateManifestUrl
    || process.env.BLOODPACT_UPDATE_URL
    || ''
  ).trim();

  if (isPlaceholderUpdateUrl(candidate)) {
    return '';
  }
  return candidate;
}

function packVersionPath(launcherRoot) {
  return path.join(getBloodpactRoot(launcherRoot), 'pack-version.json');
}

function readLocalPackVersion(launcherRoot) {
  return readJson(packVersionPath(launcherRoot), { version: '0.0.0', files: {} });
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function compareVersions(left, right) {
  const parse = (value) => String(value || '0.0.0').split('.').map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function fetchText(url, redirectLimit = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http://') ? http : https;
    const request = client.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectLimit <= 0) {
          reject(new Error('Too many redirects while fetching update manifest'));
          return;
        }
        fetchText(res.headers.location, redirectLimit - 1).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Update server returned ${res.statusCode}`));
        return;
      }

      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve(body));
    });

    request.on('error', reject);
    request.setTimeout(30000, () => {
      request.destroy(new Error('Update check timed out'));
    });
  });
}

function downloadFile(url, destination, redirectLimit = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http://') ? http : https;
    const request = client.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectLimit <= 0) {
          reject(new Error(`Too many redirects while downloading ${url}`));
          return;
        }
        downloadFile(res.headers.location, destination, redirectLimit - 1).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Download failed (${res.statusCode}) for ${url}`));
        return;
      }

      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const tempPath = `${destination}.download`;
      const fileStream = fs.createWriteStream(tempPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close(() => resolve(tempPath));
      });
      fileStream.on('error', reject);
    });

    request.on('error', reject);
    request.setTimeout(120000, () => {
      request.destroy(new Error(`Download timed out for ${url}`));
    });
  });
}

function buildDownloadUrl(manifest, fileEntry) {
  if (fileEntry.url) {
    return fileEntry.url;
  }
  const baseUrl = manifest.baseUrl || '';
  if (!baseUrl) {
    throw new Error(`No download URL for ${fileEntry.path}`);
  }
  const joined = `${baseUrl.replace(/\/+$/, '')}/${normalizeRelPath(fileEntry.path)}`;
  return joined;
}

function listPendingFiles(launcherRoot, manifest, localVersion) {
  const bloodpactRoot = getBloodpactRoot(launcherRoot);
  const pending = [];

  for (const fileEntry of manifest.files || []) {
    const relPath = normalizeRelPath(fileEntry.path);
    if (!isUpdatablePath(relPath)) {
      continue;
    }

    const localPath = path.join(bloodpactRoot, ...relPath.split('/'));
    let localHash = null;
    if (fs.existsSync(localPath)) {
      try {
        localHash = hashFile(localPath);
      } catch {
        localHash = null;
      }
    }

    const recordedHash = localVersion.files?.[relPath] || null;
    const matchesManifest = localHash && localHash === fileEntry.sha256;
    const matchesRecorded = recordedHash && recordedHash === fileEntry.sha256;
    const versionMatches = compareVersions(localVersion.version, manifest.version) >= 0;

    if (!matchesManifest && !(versionMatches && matchesRecorded)) {
      pending.push({
        ...fileEntry,
        path: relPath,
        localPath
      });
    }
  }

  return pending;
}

async function checkForUpdates(launcherRoot) {
  const manifestUrl = getUpdateManifestUrl(launcherRoot);
  if (!manifestUrl) {
    return {
      status: 'disabled',
      reason: 'Cloud updates are not set up yet. You can still play — ignore this unless you host your own update link.'
    };
  }

  const localVersion = readLocalPackVersion(launcherRoot);
  let manifest;
  try {
    manifest = parseJsonString(await fetchText(manifestUrl), null);
    if (!manifest) {
      throw new Error('Update manifest was empty or invalid JSON.');
    }
  } catch (error) {
    return {
      status: 'error',
      reason: formatNetworkError(error)
    };
  }

  const pending = listPendingFiles(launcherRoot, manifest, localVersion);
  const totalBytes = pending.reduce((sum, file) => sum + (file.size || 0), 0);

  return {
    status: pending.length ? 'available' : 'current',
    manifestUrl,
    localVersion: localVersion.version || '0.0.0',
    remoteVersion: manifest.version || '0.0.0',
    changelog: manifest.changelog || '',
    pendingCount: pending.length,
    pendingBytes: totalBytes,
    pendingFiles: pending.map((file) => file.path),
    manifest
  };
}

async function applyUpdates(launcherRoot) {
  const check = await checkForUpdates(launcherRoot);
  if (check.status === 'disabled') {
    return check;
  }
  if (check.status === 'error') {
    return check;
  }
  if (check.status === 'current') {
    return {
      ...check,
      status: 'current',
      message: 'BloodPact is already up to date.'
    };
  }

  const manifest = check.manifest;
  const pending = listPendingFiles(launcherRoot, manifest, readLocalPackVersion(launcherRoot));
  const applied = [];

  for (const fileEntry of pending) {
    const downloadUrl = buildDownloadUrl(manifest, fileEntry);
    const tempPath = await downloadFile(downloadUrl, fileEntry.localPath);
    const downloadedHash = hashFile(tempPath);
    if (downloadedHash !== fileEntry.sha256) {
      fs.unlinkSync(tempPath);
      throw new Error(`Update file failed verification: ${fileEntry.path}`);
    }
    fs.renameSync(tempPath, fileEntry.localPath);
    applied.push(fileEntry.path);
  }

  const fileMap = {};
  for (const fileEntry of manifest.files || []) {
    const relPath = normalizeRelPath(fileEntry.path);
    if (isUpdatablePath(relPath)) {
      fileMap[relPath] = fileEntry.sha256;
    }
  }

  writeJson(packVersionPath(launcherRoot), {
    version: manifest.version || check.remoteVersion,
    updatedAt: new Date().toISOString(),
    files: fileMap
  });

  return {
    status: 'updated',
    localVersion: check.localVersion,
    remoteVersion: manifest.version || check.remoteVersion,
    appliedCount: applied.length,
    appliedFiles: applied,
    changelog: manifest.changelog || '',
    message: `Updated to v${manifest.version || check.remoteVersion} (${applied.length} files).`
  };
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) {
    return '0 B';
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

module.exports = {
  applyUpdates,
  checkForUpdates,
  formatBytes,
  getUpdateManifestUrl,
  isUpdatablePath,
  isPlaceholderUpdateUrl,
  normalizeRelPath,
  readLocalPackVersion
};
