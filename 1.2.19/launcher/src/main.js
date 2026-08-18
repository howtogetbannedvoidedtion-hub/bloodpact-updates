const { app, BrowserWindow, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const {
  syncMods,
  getModCatalog,
  updateModToggle,
  selectProfile,
  readJson,
  writeJson,
  scanLocalMods,
  searchModrinth,
  installCustomMod,
  removeCustomMod,
  toggleCustomMod,
  listCustomMods,
  searchMods
} = require('./modManager');
const { defaultMinecraftDir, defaultJavaPath, prepareAndLaunch, ensureGameInstalled, getJavaInfo, getMaxSafeMemoryMb, getSystemMemoryMb, isLowRamSystem, memoryMbToLabel, resolveLaunchMemory, ensureAccountUsername, getDefaultUsername, sanitizeUsername, resolveMinecraftDir, assertWritableInstallPath, isBlockedInstallPath, formatInstallError } = require('./launcherService');
const { getLatestCrashInfo, openCrashReport, readCrashReport } = require('./crashLogService');
const { checkForUpdates, applyUpdates, formatBytes, readLocalPackVersion } = require('./updateService');
const {
  listSeedsForUi,
  selectCatalogSeed,
  setCustomSeed,
  clearSelectedSeed
} = require('./opSeedService');
const {
  listModpacks,
  resolveProfile,
  migrateLegacyProfile,
  instanceModsDir,
  getSelectedProfileId
} = require('./modpackRegistry');

const launcherRoot = path.resolve(__dirname, '..');
const iconPath = path.join(launcherRoot, 'assets', 'icon.png');
let mainWindow;

function applySharePackDefaults(config) {
  const sharePackPath = path.join(launcherRoot, 'share-pack.json');
  if (!fs.existsSync(sharePackPath)) {
    return config;
  }
  const sharePack = readJson(sharePackPath, {});
  if (!config.curseForgeApiKey && sharePack.curseForgeApiKey) {
    config.curseForgeApiKey = sharePack.curseForgeApiKey;
  }
  return config;
}

function buildLaunchSettings(modpacks, javaInfo, memory, javaMajor) {
  const lowRamSystem = typeof isLowRamSystem === 'function' ? isLowRamSystem() : false;
  const hasLitePack = modpacks.some((pack) => pack.id === 'bloodpact-lite-26.1.2');
  return {
    javaPath: javaInfo.javaPath,
    javaMajor: javaInfo.installedMajor,
    requiredJavaMajor: javaMajor,
    javaCompatible: javaInfo.compatible,
    systemMemoryMb: getSystemMemoryMb(),
    maxSafeMemoryMb: getMaxSafeMemoryMb(),
    maxSafeMemoryLabel: memoryMbToLabel(getMaxSafeMemoryMb()),
    selectedMemoryMb: memory.maxMemoryMb,
    selectedMemoryLabel: memoryMbToLabel(memory.maxMemoryMb),
    memoryClamped: memory.wasClamped,
    lowRamSystem,
    suggestLiteProfileId: lowRamSystem && hasLitePack ? 'bloodpact-lite-26.1.2' : null
  };
}

function ensureConfigDefaults(config) {
  const modpacks = listModpacks(launcherRoot);
  migrateLegacyProfile(config, modpacks);
  ensureAccountUsername(config);
  applySharePackDefaults(config);
  config.profiles = config.profiles || {};
  config.minecraftDir = resolveMinecraftDir(launcherRoot, config);
  config.portableMode = config.portableMode !== false;
  try {
    assertWritableInstallPath(path.resolve(launcherRoot, '..'), 'BloodPact folder');
    fs.mkdirSync(config.minecraftDir, { recursive: true });
  } catch (error) {
    config.launchBlockedReason = error.message;
  }
  if (!config.javaPath) {
    config.javaPath = defaultJavaPath(launcherRoot);
  } else if (config.javaPath === 'java') {
    config.javaPath = defaultJavaPath(launcherRoot);
  }
  return config;
}

function loadInitialConfig() {
  const configPath = path.join(launcherRoot, 'config.json');
  const examplePath = path.join(launcherRoot, 'config.example.json');
  if (!fs.existsSync(configPath) && fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, configPath);
  }
  const config = ensureConfigDefaults(readJson(configPath, {}));
  writeJson(configPath, config);
  return config;
}

function getWindowIcon() {
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#070408',
    autoHideMenuBar: true,
    title: 'BloodPact',
    icon: getWindowIcon(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.loadFile(path.join(launcherRoot, 'ui', 'index.html'));
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.bloodpact.launcher');
  }

  try {
    loadInitialConfig();
    createWindow();
  } catch (error) {
    const logPath = path.join(launcherRoot, 'bloodpact-launcher.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] main startup error: ${error.stack || error.message}\n`);
    throw error;
  }
});

process.on('uncaughtException', (error) => {
  const logPath = path.join(launcherRoot, 'bloodpact-launcher.log');
  try {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] uncaughtException: ${error.stack || error.message}\n`);
  } catch {
    // ignore
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('launcher:get-state', async () => {
  const configPath = path.join(launcherRoot, 'config.json');
  const config = ensureConfigDefaults(readJson(configPath, {}));
  writeJson(configPath, config);
  const profile = resolveProfile(config, launcherRoot);
  const catalog = getModCatalog(launcherRoot);
  const minecraftDir = resolveMinecraftDir(launcherRoot, config);
  const profileId = getSelectedProfileId(config);
  const modpacks = listModpacks(launcherRoot);
  const javaMajor = profile.modpack?.javaMajor || 21;
  const javaInfo = getJavaInfo(config, javaMajor, launcherRoot);
  const memory = resolveLaunchMemory(profile.memory, profile.modpack?.defaultMemory || '4G');
  const latestCrash = getLatestCrashInfo(launcherRoot, minecraftDir, profileId);
  const packVersion = readLocalPackVersion(launcherRoot);
  const opSeeds = listSeedsForUi(launcherRoot, config, minecraftDir);
  return {
    config,
    defaultUsername: getDefaultUsername(config),
    profile,
    catalog,
    modpacks,
    latestCrash,
    packVersion: packVersion.version || '0.0.0',
    customMods: listCustomMods(launcherRoot, minecraftDir, profileId),
    localMods: scanLocalMods(instanceModsDir(minecraftDir, profileId)),
    minecraftDir,
    instanceModsDir: instanceModsDir(minecraftDir, profileId),
    launchSettings: buildLaunchSettings(modpacks, javaInfo, memory, javaMajor),
    launchBlockedReason: config.launchBlockedReason || null,
    opSeeds
  };
});

ipcMain.handle('launcher:select-profile', async (_event, profileId) => {
  const config = selectProfile(launcherRoot, profileId);
  return { ok: true, config };
});

ipcMain.handle('launcher:sync-mods', async () => {
  const config = readJson(path.join(launcherRoot, 'config.json'), {});
  return syncMods({
    launcherRoot,
    minecraftDir: resolveMinecraftDir(launcherRoot, config)
  });
});

ipcMain.handle('launcher:toggle-mod', async (_event, modId, enabled) => {
  return updateModToggle(launcherRoot, modId, enabled);
});

ipcMain.handle('launcher:save-settings', async (_event, settings) => {
  const configPath = path.join(launcherRoot, 'config.json');
  const config = readJson(configPath, {});
  Object.assign(config, settings);
  if (config.accountUsername) {
    config.accountUsername = sanitizeUsername(config.accountUsername);
  }
  ensureAccountUsername(config);
  writeJson(configPath, config);
  return config;
});

ipcMain.handle('launcher:search-modrinth', async (_event, query) => {
  return searchModrinth(query, { launcherRoot });
});

ipcMain.handle('launcher:search-mods', async (_event, source, query) => {
  return searchMods(source, query, { launcherRoot });
});

ipcMain.handle('launcher:install-custom-mod', async (_event, source, id) => {
  return installCustomMod(launcherRoot, source, id);
});

ipcMain.handle('launcher:remove-custom-mod', async (_event, modId) => {
  return removeCustomMod(launcherRoot, modId);
});

ipcMain.handle('launcher:toggle-custom-mod', async (_event, modId, enabled) => {
  const result = toggleCustomMod(launcherRoot, modId, enabled);
  if (result.ok && result.needsSync) {
    const config = readJson(path.join(launcherRoot, 'config.json'), {});
    await syncMods({
      launcherRoot,
      minecraftDir: resolveMinecraftDir(launcherRoot, config),
      fast: false
    });
  }
  return result;
});

ipcMain.handle('launcher:open-external', async (_event, url) => {
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('launcher:open-crash-log', async () => {
  const config = readJson(path.join(launcherRoot, 'config.json'), {});
  const minecraftDir = resolveMinecraftDir(launcherRoot, config);
  const profileId = getSelectedProfileId(config);
  const latestCrash = getLatestCrashInfo(launcherRoot, minecraftDir, profileId);
  if (!latestCrash) {
    return { ok: false, error: 'No crash report found for this profile.' };
  }
  return openCrashReport(latestCrash.archivedPath || latestCrash.path);
});

ipcMain.handle('launcher:get-crash-log', async () => {
  const config = readJson(path.join(launcherRoot, 'config.json'), {});
  const minecraftDir = resolveMinecraftDir(launcherRoot, config);
  const profileId = getSelectedProfileId(config);
  const latestCrash = getLatestCrashInfo(launcherRoot, minecraftDir, profileId);
  if (!latestCrash) {
    return { ok: true, crash: null };
  }
  return {
    ok: true,
    crash: {
      ...latestCrash,
      text: readCrashReport(latestCrash.archivedPath || latestCrash.path)
    }
  };
});

ipcMain.handle('launcher:check-updates', async () => {
  return checkForUpdates(launcherRoot);
});

ipcMain.handle('launcher:apply-updates', async () => {
  return applyUpdates(launcherRoot);
});

ipcMain.handle('launcher:select-op-seed', async (_event, seedId) => {
  return selectCatalogSeed(launcherRoot, seedId);
});

ipcMain.handle('launcher:set-custom-op-seed', async (_event, seedValue) => {
  return setCustomSeed(launcherRoot, seedValue);
});

ipcMain.handle('launcher:clear-op-seed', async () => {
  return clearSelectedSeed(launcherRoot);
});

ipcMain.handle('launcher:play', async (_event, username) => {
  try {
    const config = readJson(path.join(launcherRoot, 'config.json'), {});
    const minecraftDir = resolveMinecraftDir(launcherRoot, config);
    const profile = resolveProfile(config, launcherRoot);
    const modpack = profile.modpack;
    let syncResult;
    let versionId;

    try {
      [syncResult, { versionId }] = await Promise.all([
        syncMods({
          launcherRoot,
          minecraftDir,
          fast: true
        }),
        ensureGameInstalled(minecraftDir, modpack)
      ]);
    } catch (error) {
      return {
        ok: false,
        stage: 'sync',
        error: formatInstallError(error)
      };
    }

    const missingRequired = syncResult.results.filter((entry) =>
      entry.enabled && (entry.status === 'missing' || entry.status === 'error')
    );

    if (missingRequired.length > 0) {
      const missingIds = missingRequired.map((entry) => entry.id);
      let error = `Missing required mods: ${missingIds.join(', ')}`;
      if (missingIds.includes('bloodpact')) {
        const bloodpactRoot = path.resolve(launcherRoot, '..');
        error += '. Extract the BloodPact folder from the zip (do not run inside the zip).';
        error += ` Look for bundled-mods\\bloodpact-26.1.2-1.0.0.jar in ${bloodpactRoot}.`;
        error += ' Ask your friend to send BloodPact-Mod-Fix.zip (9-Send-Mod-Fix.bat) and extract it into the BloodPact folder.';
      }
      return {
        ok: false,
        stage: 'sync',
        syncResult,
        error
      };
    }

    const dependencyCount = (syncResult.dependencyResults || []).length;

    try {
      const launchResult = await prepareAndLaunch({
        launcherRoot,
        username,
        versionId,
        skipGameInstall: true
      });
      return {
        ok: true,
        stage: 'launch',
        syncResult,
        dependencyCount,
        pid: launchResult?.pid || null,
        memoryMb: launchResult?.memoryMb || null,
        memoryClamped: launchResult?.memoryClamped || false,
        javaPath: launchResult?.javaPath || null,
        message: dependencyCount > 0
          ? `Installed ${dependencyCount} required mod dependencies automatically.`
          : undefined
      };
    } catch (error) {
      return { ok: false, stage: 'launch', syncResult, error: formatInstallError(error) };
    }
  } catch (error) {
    return { ok: false, stage: 'launch', error: formatInstallError(error) };
  }
});
