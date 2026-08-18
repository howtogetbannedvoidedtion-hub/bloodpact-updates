const path = require('path');
const fs = require('fs');
const os = require('os');
const { createHash } = require('crypto');
const { execSync, spawn } = require('child_process');
const { launch, Version } = require('@xmcl/core');
const {
  getVersionList,
  installFabric,
  getFabricLoaderArtifact,
  installVersion,
  installLibraries,
  installAssets
} = require('@xmcl/installer');
const { readJson, writeJson } = require('./modManager');
const { seedPerformanceDefaults } = require('./instancePerformance');
const { writeSeedFiles } = require('./opSeedService');
const { resolveProfile, instanceDir } = require('./modpackRegistry');
const { findBundledJavaExecutable } = require('./bundledRuntime');

const INSTALL_OPTS = {
  skipPrevalidate: true,
  skipRevalidate: true
};

function sanitizeUsername(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 16);
  return cleaned || 'BloodPactPlayer';
}

function offlineUuidFromUsername(username) {
  const hash = createHash('md5').update(`OfflinePlayer:${username}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return hash.toString('hex');
}

function ensureAccountUsername(config) {
  if (!config.accountUsername) {
    config.accountUsername = sanitizeUsername(config.lastUsername || os.userInfo().username);
  } else {
    config.accountUsername = sanitizeUsername(config.accountUsername);
  }
  return config;
}

function getDefaultUsername(config) {
  ensureAccountUsername(config);
  return config.accountUsername;
}

const LAUNCH_TARGET_FILE = 'bloodpact-launch-target.json';

function resolveLaunchServer(modpack) {
  const server = modpack?.server || modpack?.quickConnect;
  if (!server?.host) {
    return undefined;
  }

  const launchServer = { ip: server.host };
  if (server.port != null) {
    launchServer.port = Number(server.port);
  }
  return launchServer;
}

function formatQuickPlayAddress(launchServer) {
  if (!launchServer?.ip) {
    return undefined;
  }
  const port = launchServer.port != null ? Number(launchServer.port) : 25565;
  return port === 25565 ? launchServer.ip : `${launchServer.ip}:${port}`;
}

function buildLaunchFeatures(launchServer) {
  const address = formatQuickPlayAddress(launchServer);
  if (!address) {
    return undefined;
  }

  // MC 26.x ignores --server/--port; quickPlayMultiplayer is the supported path.
  return {
    is_quick_play_multiplayer: true,
    quickPlayMultiplayer: { quickPlayMultiplayer: address }
  };
}

function writeLaunchTarget(gameDir, launchServer, profileId) {
  const targetPath = path.join(gameDir, LAUNCH_TARGET_FILE);
  if (!launchServer?.ip) {
    try {
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
    } catch {
      // ignore cleanup errors
    }
    return;
  }

  writeJson(targetPath, {
    host: launchServer.ip,
    port: launchServer.port != null ? Number(launchServer.port) : 25565,
    profileId: profileId || null,
    writtenAt: new Date().toISOString()
  });
}

function formatInstallError(error) {
  if (!error) {
    return 'Unknown error';
  }

  const nested = error.errors || (error instanceof AggregateError ? error.errors : null);
  if (nested?.length) {
    const counts = new Map();
    for (const entry of nested) {
      const root = entry?.errors?.[0] || entry;
      const key = (root?.message || root?.name || 'Download failed').split('\n')[0].trim();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const parts = [...counts.entries()].slice(0, 3).map(([msg, count]) =>
      count > 1 ? `${msg} (×${count})` : msg
    );
    const suffix = nested.length > 3 ? ` …and ${nested.length - 3} more` : '';
    return `Could not download ${nested.length} game file(s): ${parts.join('; ')}${suffix}. Check your internet and try again.`;
  }

  const message = error.message || String(error);
  if (/Connect Timeout|DownloadAggregateError|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message)) {
    return formatNetworkError(error);
  }
  if (message.includes("assets at")) {
    return 'Could not download Minecraft assets. If you use the official Minecraft Launcher, open that version once, then try BloodPact again.';
  }
  return message;
}

function defaultMinecraftDir(launcherRoot) {
  return path.resolve(launcherRoot, '..', 'game');
}

function getBloodpactRoot(launcherRoot) {
  return path.resolve(launcherRoot, '..');
}

function isBlockedInstallPath(targetPath) {
  if (!targetPath) {
    return false;
  }
  const normalized = String(targetPath);
  return /\.zip([\\/]|$)/i.test(normalized);
}

function resolveMinecraftDir(launcherRoot, config = {}) {
  let dir = config.minecraftDir;
  if (!dir || isBlockedInstallPath(dir)) {
    dir = defaultMinecraftDir(launcherRoot);
    config.minecraftDir = dir;
    config.portableMode = true;
  }
  return path.resolve(dir);
}

function assertWritableInstallPath(targetPath, label = 'BloodPact folder') {
  const resolved = path.resolve(targetPath || '');
  if (isBlockedInstallPath(resolved)) {
    throw new Error(
      `${label} is still inside a zip file. Right-click the zip → Extract All, open the extracted BloodPact-For-Friend folder, then run 2-Open-BloodPact.bat.`
    );
  }

  fs.mkdirSync(resolved, { recursive: true });
  const probe = path.join(resolved, `.bloodpact-write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch {
    throw new Error(
      `Cannot write to ${label} (${resolved}). Extract the BloodPact folder to your Desktop first — do not run it from inside the zip.`
    );
  }
}

function normalizeMemoryMb(value, fallbackMb) {
  if (value == null || value === '') {
    return fallbackMb;
  }

  const raw = String(value).trim().toUpperCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)([GMK])?$/);
  if (!match) {
    return fallbackMb;
  }

  const amount = Number(match[1]);
  const unit = match[2] || 'M';
  if (unit === 'G') {
    return Math.round(amount * 1024);
  }
  if (unit === 'K') {
    return Math.max(1, Math.round(amount / 1024));
  }
  return Math.round(amount);
}

function memoryMbToLabel(mb) {
  if (mb >= 1024 && mb % 1024 === 0) {
    return `${mb / 1024} GB`;
  }
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${mb} MB`;
}

const LOW_RAM_SYSTEM_THRESHOLD_MB = 5120;

function getSystemMemoryMb() {
  return Math.floor(os.totalmem() / (1024 * 1024));
}

function isLowRamSystem() {
  return getSystemMemoryMb() <= LOW_RAM_SYSTEM_THRESHOLD_MB;
}

function getMaxSafeMemoryMb() {
  const systemMb = getSystemMemoryMb();
  if (systemMb <= LOW_RAM_SYSTEM_THRESHOLD_MB) {
    return Math.max(1024, Math.floor(systemMb * 0.45) - 384);
  }
  return Math.max(1024, Math.floor(systemMb * 0.75) - 1024);
}

function formatNetworkError(error) {
  const message = error?.message || String(error || '');
  const code = error?.code || '';
  const blob = `${code} ${message}`;

  if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|Connect Timeout|DownloadAggregateError/i.test(blob)) {
    return 'Network connection dropped (ECONNRESET / timeout). Check Wi‑Fi, wait a few seconds, and click Play again. If mods were downloaded once before, try Play again without changing packs.';
  }
  if (/Update check timed out/i.test(message)) {
    return 'Update check timed out — you can still play. Use Settings → Check for updates when your connection is stable.';
  }
  return message;
}

function resolveLaunchMemory(memorySetting, fallbackSetting = '4G') {
  const requestedMb = normalizeMemoryMb(memorySetting, normalizeMemoryMb(fallbackSetting, 4096));
  const safeMaxMb = getMaxSafeMemoryMb();
  const maxMemoryMb = Math.min(requestedMb, safeMaxMb);
  const minMemoryMb = Math.min(512, maxMemoryMb);
  return {
    requestedMb,
    maxMemoryMb,
    minMemoryMb,
    safeMaxMb,
    wasClamped: requestedMb > maxMemoryMb
  };
}

function getJavaMajorVersion(javaPath) {
  if (!javaPath || javaPath === 'java') {
    return null;
  }
  try {
    const output = execSync(`"${javaPath}" -version 2>&1`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const match = output.match(/version "(\d+(?:\.\d+)?)/);
    if (!match) {
      return null;
    }
    const version = Number(match[1]);
    return version === 1 ? 8 : version;
  } catch {
    return null;
  }
}

function isJavaCompatible(installedMajor, requiredMajor) {
  if (!installedMajor) {
    return false;
  }
  if (requiredMajor === 8) {
    return installedMajor === 8;
  }
  if (requiredMajor >= 25) {
    return installedMajor >= 25;
  }
  if (requiredMajor >= 21) {
    return installedMajor >= 21;
  }
  if (requiredMajor >= 17) {
    return installedMajor >= 17;
  }
  return installedMajor >= requiredMajor;
}

function resolveJavaPath(config, javaMajor = 21, launcherRoot = path.resolve(__dirname, '..')) {
  const candidates = [];

  const bundled = findBundledJavaExecutable(launcherRoot, javaMajor);
  if (bundled) {
    candidates.push(bundled);
  }

  const discovered = findJavaExecutable(javaMajor, launcherRoot);
  if (discovered) {
    candidates.push(discovered);
  }

  if (javaMajor >= 25) {
    const fallback25 = findJavaExecutable(25, launcherRoot);
    if (fallback25) {
      candidates.push(fallback25);
    }
  }

  if (javaMajor >= 21 && javaMajor < 25) {
    const fallback21 = findJavaExecutable(21, launcherRoot);
    if (fallback21) {
      candidates.push(fallback21);
    }
  }

  if (javaMajor === 8) {
    const fallback8 = findJavaExecutable(8, launcherRoot);
    if (fallback8) {
      candidates.push(fallback8);
    }
  }

  const configured = config?.javaPath;
  if (configured && configured !== 'java' && fs.existsSync(configured)) {
    candidates.push(configured);
  }

  const javaHome = process.env.JAVA_HOME;
  if (javaHome) {
    const fromHome = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(fromHome)) {
      candidates.push(fromHome);
    }
  }

  for (const candidate of [...new Set(candidates)]) {
    const installedMajor = getJavaMajorVersion(candidate);
    if (isJavaCompatible(installedMajor, javaMajor)) {
      return candidate;
    }
  }

  return findJavaExecutable(21, launcherRoot) || findJavaExecutable(17, launcherRoot) || configured || 'java';
}

function getJavaInfo(config, javaMajor = 21, launcherRoot = path.resolve(__dirname, '..')) {
  const javaPath = resolveJavaPath(config, javaMajor, launcherRoot);
  const installedMajor = getJavaMajorVersion(javaPath);
  return {
    javaPath,
    requiredMajor: javaMajor,
    installedMajor,
    compatible: isJavaCompatible(installedMajor, javaMajor)
  };
}

function filterJvmArgsForJava(args, javaMajor) {
  if (javaMajor >= 25) {
    return args;
  }

  return args.filter((arg) => {
    if (arg.includes('sun-misc-unsafe-memory-access')) {
      return false;
    }
    if (arg.includes('UseCompactObjectHeaders')) {
      return false;
    }
    return true;
  });
}
function findJavaExecutable(javaMajor = 21, launcherRoot = path.resolve(__dirname, '..')) {
  const bundled = findBundledJavaExecutable(launcherRoot, javaMajor);
  if (bundled) {
    return bundled;
  }

  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Eclipse Adoptium'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Eclipse Adoptium'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Java'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Amazon Corretto')
  ];

  const patterns = {
    8: /jdk-?1\.8|jdk-?8|jre-?1\.8|jre-?8/i,
    17: /jdk-?17|jre-?17/i,
    21: /jdk-?21|jre-?21/i,
    25: /jdk-?25|jre-?25/i
  };
  const pattern = patterns[javaMajor] || new RegExp(`jdk-?${javaMajor}|jre-?${javaMajor}`, 'i');
  const matches = [];

  for (const root of roots) {
    if (!fs.existsSync(root)) {
      continue;
    }
    for (const entry of fs.readdirSync(root)) {
      if (!pattern.test(entry)) {
        continue;
      }
      const javaExe = path.join(root, entry, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      if (fs.existsSync(javaExe)) {
        matches.push(javaExe);
      }
    }
  }

  return matches.sort().reverse()[0] || null;
}

function formatLaunchLog(logText, context = {}) {
  const lines = logText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = lines.filter((line) =>
    /error|exception|could not|invalid|failed|fatal|crash/i.test(line)
  );
  const tail = (useful.length ? useful : lines).slice(-4).join(' ');

  if (/sun-misc-unsafe-memory-access/i.test(logText)) {
    return `This Minecraft version needs Java ${context.requiredMajor || 25}+. BloodPact will use Java 25 automatically when it is installed. ${tail}`.trim();
  }
  if (/Invalid initial heap size|Could not create the Java Virtual Machine/i.test(logText)) {
    const safe = context.safeMaxMb ? memoryMbToLabel(context.safeMaxMb) : 'a lower value';
    return `Java could not start with the selected RAM. Try ${safe} or lower in Settings. ${tail}`.trim();
  }
  if (/Unrecognized option/i.test(logText) && context.requiredMajor >= 25) {
    return `Install Java 25 for Minecraft ${context.minecraftVersion || '26.x'}. ${tail}`.trim();
  }

  return tail || 'Java exited immediately. Open bloodpact-launch.log in your .minecraft folder for details.';
}

function isProcessAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultJavaPath(launcherRoot = path.resolve(__dirname, '..')) {
  return findBundledJavaExecutable(launcherRoot, 25)
    || findBundledJavaExecutable(launcherRoot, 21)
    || findJavaExecutable(25, launcherRoot)
    || findJavaExecutable(21, launcherRoot)
    || 'java';
}

async function ensureVanillaReady(minecraftDir, version) {
  if (!version || version === '0.0.0') {
    throw new Error('No valid Minecraft version for this pack. Select a version pack in the launcher and try again.');
  }

  const versionJson = path.join(minecraftDir, 'versions', version, `${version}.json`);
  if (!fs.existsSync(versionJson)) {
    const manifest = await getVersionList();
    const versionMeta = manifest.versions.find((entry) => entry.id === version);
    if (!versionMeta) {
      throw new Error(`Minecraft version ${version} was not found in the version manifest`);
    }
    await installVersion(versionMeta, minecraftDir, INSTALL_OPTS);
  }

  const parsed = await Version.parse(minecraftDir, version);
  await installLibraries(parsed, INSTALL_OPTS);

  const assetIndexPath = path.join(minecraftDir, 'assets', 'indexes', `${parsed.assets}.json`);
  if (!fs.existsSync(assetIndexPath)) {
    try {
      await installAssets(parsed, INSTALL_OPTS);
    } catch (error) {
      console.warn('[BloodPact] Asset install incomplete:', formatInstallError(error));
    }
  }

  return parsed;
}

async function ensureFabricReady(minecraftDir, version, fabricLoaderVersion) {
  const fabricVersionId = `fabric-loader-${fabricLoaderVersion}-${version}`;
  const fabricJson = path.join(minecraftDir, 'versions', fabricVersionId, `${fabricVersionId}.json`);
  if (!fs.existsSync(fabricJson)) {
    const loaderArtifact = await getFabricLoaderArtifact(version, fabricLoaderVersion);
    await installFabric(loaderArtifact, minecraftDir, { versionId: fabricVersionId });
  }

  const parsed = await Version.parse(minecraftDir, fabricVersionId);
  await installLibraries(parsed, INSTALL_OPTS);
  return fabricVersionId;
}

async function ensureGameInstalled(minecraftDir, modpack) {
  const version = modpack?.minecraftVersion;
  if (!version || version === '0.0.0') {
    throw new Error(`This profile has no Minecraft version set. Pick a pack like Fabric 26.1.2 or BloodPact 26.1.2.`);
  }

  assertWritableInstallPath(minecraftDir, 'Minecraft game folder');
  await ensureVanillaReady(minecraftDir, version);

  if ((modpack.loader || 'fabric') === 'vanilla') {
    return { versionId: version, stages: ['minecraft'] };
  }

  const fabricLoaderVersion = modpack.fabricLoaderVersion || '0.16.9';
  const versionId = await ensureFabricReady(minecraftDir, version, fabricLoaderVersion);
  return { versionId, stages: ['minecraft', 'fabric'] };
}

function readLaunchLogTail(launchLogPath, maxChars = 12000) {
  try {
    const text = fs.readFileSync(launchLogPath, 'utf8');
    return text.slice(-maxChars);
  } catch {
    return '';
  }
}

function detectStartupCrash(logTail) {
  if (!logTail) {
    return null;
  }
  if (/Game crashed! Crash report saved to:/i.test(logTail)) {
    return 'Minecraft crashed during startup. Check Settings → crash log, or try disabling mods one by one.';
  }
  if (/MixinApplyError|Mixin transformation of .* failed|Failed to start Minecraft/i.test(logTail)) {
    return formatLaunchLog(logTail, {});
  }
  return null;
}

async function waitForLaunchResult(child, launchLogPath, logContext = {}, timeoutMs = 30000, logOffset = 0) {
  const startedAt = Date.now();
  const pollMs = 1000;
  let lastCheckedLength = logOffset;

  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(child.pid)) {
      const logTail = readLaunchLogTail(launchLogPath);
      throw new Error(`Minecraft closed during startup: ${formatLaunchLog(logTail, logContext)}`);
    }

    let logTail = '';
    try {
      const fullLog = fs.readFileSync(launchLogPath, 'utf8');
      if (fullLog.length > lastCheckedLength) {
        logTail = fullLog.slice(Math.max(0, lastCheckedLength));
        lastCheckedLength = fullLog.length;
      }
    } catch {
      logTail = '';
    }

    const crashMessage = detectStartupCrash(logTail);
    if (crashMessage) {
      throw new Error(crashMessage);
    }

    if (/Sound engine started|Created: .*window|OpenAL initialized/i.test(logTail)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  if (!isProcessAlive(child.pid)) {
    const logTail = readLaunchLogTail(launchLogPath);
    throw new Error(`Minecraft closed during startup: ${formatLaunchLog(logTail, logContext)}`);
  }
}

async function prepareAndLaunch(options) {
  const launcherRoot = options.launcherRoot;
  const configPath = path.join(launcherRoot, 'config.json');
  const config = readJson(configPath, {});
  const resolved = resolveProfile(config, launcherRoot);
  const modpack = resolved.modpack;

  const resourceDir = resolveMinecraftDir(launcherRoot, config);
  const gameDir = instanceDir(resourceDir, resolved.id);
  const javaMajor = modpack.javaMajor || 21;
  const javaInfo = getJavaInfo(config, javaMajor, launcherRoot);
  const javaPath = javaInfo.javaPath;
  const memory = resolveLaunchMemory(resolved.memory, modpack.defaultMemory || '4G');
  ensureAccountUsername(config);
  const username = sanitizeUsername(options.username || config.accountUsername);
  const launchLogPath = path.join(resourceDir, 'bloodpact-launch.log');
  const offlineUuid = offlineUuidFromUsername(username);
  const launchServer = resolveLaunchServer(modpack);
  const logContext = {
    requiredMajor: javaMajor,
    installedMajor: javaInfo.installedMajor,
    safeMaxMb: memory.safeMaxMb,
    minecraftVersion: modpack.minecraftVersion
  };

  if (!modpack?.minecraftVersion) {
    throw new Error('No version pack loaded. Pick a profile in the launcher dropdown and try Play again.');
  }

  if (!javaInfo.compatible) {
    if (javaMajor >= 25) {
      throw new Error(`Minecraft ${modpack.minecraftVersion} needs Java 25. Run 2-Open-BloodPact.bat once with internet to download bundled Java, or install Temurin JDK 25.`);
    }
    if (javaMajor === 8) {
      throw new Error('Minecraft 1.8.9 needs Java 8. Install a Java 8 JDK, then try again.');
    }
    throw new Error(`This version pack needs Java ${javaMajor}. BloodPact could not find a matching install.`);
  }

  fs.mkdirSync(gameDir, { recursive: true });
  fs.mkdirSync(path.join(gameDir, 'mods'), { recursive: true });
  seedPerformanceDefaults(gameDir, {
    lowRam: (typeof isLowRamSystem === 'function' && isLowRamSystem()) || resolved.modpack?.lowRamProfile === true
  });
  writeLaunchTarget(gameDir, launchServer, resolved.id);
  writeSeedFiles(gameDir, config, launcherRoot);
  const launchFeatures = buildLaunchFeatures(launchServer);

  let versionId = options.versionId;
  if (!options.skipGameInstall) {
    try {
      const installed = await ensureGameInstalled(resourceDir, modpack);
      versionId = installed.versionId;
    } catch (error) {
      throw new Error(formatInstallError(error));
    }
  } else if (!versionId || versionId === '0.0.0' || String(versionId).includes('undefined')) {
    throw new Error(
      'Minecraft failed to install. Extract the BloodPact folder from the zip to your Desktop (not inside the zip), make sure you have internet, then click Play again.'
    );
  }

  if (!versionId || versionId === '0.0.0' || versionId.includes('undefined')) {
    throw new Error(
      'Minecraft failed to install. Extract the BloodPact folder from the zip to your Desktop (not inside the zip), make sure you have internet, then click Play again.'
    );
  }

  const logFd = fs.openSync(launchLogPath, 'a');
  const launchLogOffset = fs.existsSync(launchLogPath) ? fs.statSync(launchLogPath).size : 0;
  fs.writeSync(
    logFd,
    `\n[${new Date().toISOString()}] Launching profile ${resolved.id} (${versionId}) as ${username} in ${gameDir} (${memory.maxMemoryMb} MB RAM, Java ${javaInfo.installedMajor} at ${javaPath})${launchServer ? ` -> ${launchServer.ip}${launchServer.port ? `:${launchServer.port}` : ''}` : ''}\n`
  );

  let child;
  try {
    child = await launch({
      gamePath: gameDir,
      resourcePath: resourceDir,
      javaPath,
      version: versionId,
      ...(launchServer ? { server: launchServer } : {}),
      ...(launchFeatures ? { features: launchFeatures } : {}),
      gameProfile: {
        id: offlineUuid,
        name: username
      },
      extraExecOption: {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        windowsHide: false
      },
      maxMemory: memory.maxMemoryMb,
      minMemory: memory.minMemoryMb,
      spawn: (command, args, spawnOptions) => spawn(
        command,
        filterJvmArgsForJava(args, javaInfo.installedMajor || javaMajor),
        spawnOptions
      )
    });
  } catch (error) {
    fs.closeSync(logFd);
    throw new Error(formatInstallError(error));
  }

  fs.closeSync(logFd);
  await waitForLaunchResult(child, launchLogPath, logContext, 30000, launchLogOffset);
  child.unref();

  writeJson(configPath, config);

  return {
    pid: child.pid,
    memoryMb: memory.maxMemoryMb,
    memoryClamped: memory.wasClamped,
    javaPath,
    javaMajor: javaInfo.installedMajor
  };
}

module.exports = {
  defaultMinecraftDir,
  defaultJavaPath,
  assertWritableInstallPath,
  ensureAccountUsername,
  ensureGameInstalled,
  findJavaExecutable,
  formatInstallError,
  formatNetworkError,
  getBloodpactRoot,
  getDefaultUsername,
  getJavaInfo,
  getMaxSafeMemoryMb,
  getSystemMemoryMb,
  isBlockedInstallPath,
  isLowRamSystem,
  memoryMbToLabel,
  normalizeMemoryMb,
  offlineUuidFromUsername,
  prepareAndLaunch,
  resolveJavaPath,
  resolveLaunchMemory,
  resolveMinecraftDir,
  sanitizeUsername
};
