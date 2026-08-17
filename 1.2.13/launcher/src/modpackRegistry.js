const fs = require('fs');
const path = require('path');

const MODPACKS_DIR = 'modpacks';

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function modpacksDir(launcherRoot) {
  return path.join(launcherRoot, MODPACKS_DIR);
}

function listModpackFiles(launcherRoot) {
  const dir = modpacksDir(launcherRoot);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
}

function loadModpack(launcherRoot, modpackId) {
  const filePath = path.join(modpacksDir(launcherRoot), `${modpackId}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const modpack = readJson(filePath, null);
  if (!modpack) {
    return null;
  }
  return { ...modpack, id: modpack.id || modpackId };
}

function listModpacks(launcherRoot) {
  const legacy = readJson(path.join(launcherRoot, 'modpack.json'), null);
  const fromDir = listModpackFiles(launcherRoot)
    .map((file) => loadModpack(launcherRoot, file.replace(/\.json$/, '')))
    .filter(Boolean);

  if (!fromDir.length && legacy) {
    return [{ ...legacy, id: legacy.id || 'bloodpact-1.21' }];
  }

  const seen = new Set();
  const packs = fromDir.filter((pack) => {
    if (seen.has(pack.id)) {
      return false;
    }
    seen.add(pack.id);
    return true;
  });

  return packs.sort((left, right) => {
    if (left.lowRamProfile && !right.lowRamProfile) {
      return -1;
    }
    if (!left.lowRamProfile && right.lowRamProfile) {
      return 1;
    }
    return String(left.name || left.id).localeCompare(String(right.name || right.id));
  });
}

function getSelectedProfileId(config) {
  return config.selectedProfile || 'bloodpact-1.21';
}

function migrateLegacyProfile(config, modpacks) {
  if (config.selectedProfile === 'bloodpact-pvp') {
    config.selectedProfile = 'bloodpact-1.21';
  }

  config.profiles = config.profiles || {};
  if (config.profiles['bloodpact-pvp'] && !config.profiles['bloodpact-1.21']) {
    config.profiles['bloodpact-1.21'] = {
      ...config.profiles['bloodpact-pvp'],
      modpackId: 'bloodpact-1.21'
    };
    delete config.profiles['bloodpact-pvp'];
  }

  for (const modpack of modpacks) {
    if (!config.profiles[modpack.id]) {
      const enabledMods = {};
      for (const mod of modpack.mods || []) {
        enabledMods[mod.id] = getDefaultModEnabled(mod, modpack);
      }
      config.profiles[modpack.id] = {
        name: modpack.name,
        modpackId: modpack.id,
        memory: modpack.defaultMemory || (modpack.lowRamProfile ? '2G' : '4G'),
        enabledMods
      };
    } else if (!config.profiles[modpack.id].modpackId) {
      config.profiles[modpack.id].modpackId = modpack.id;
    }
  }

  enforceEssentialMods(config, modpacks);

  if (!config.profiles[config.selectedProfile]) {
    config.selectedProfile = modpacks[0]?.id || 'bloodpact-1.21';
  }

  return config;
}

function resolveProfile(config, launcherRoot) {
  const modpacks = listModpacks(launcherRoot);
  const migrated = migrateLegacyProfile({ ...config }, modpacks);
  Object.assign(config, migrated);

  const profileId = getSelectedProfileId(config);
  const profile = config.profiles?.[profileId] || {};
  const modpackId = profile.modpackId || profileId;
  const modpack = loadModpack(launcherRoot, modpackId) || modpacks[0] || readJson(path.join(launcherRoot, 'modpack.json'), {});

  return {
    id: profileId,
    modpackId: modpack?.id || modpackId,
    name: profile.name || modpack?.name || profileId,
    memory: profile.memory || modpack?.defaultMemory || '4G',
    enabledMods: profile.enabledMods || {},
    modpack
  };
}

function instanceRoot(minecraftDir) {
  const normalized = path.resolve(minecraftDir);
  if (path.basename(normalized).toLowerCase() === 'game') {
    return path.join(path.dirname(normalized), 'instances');
  }
  return path.join(minecraftDir, 'bloodpact', 'instances');
}

function instanceDir(minecraftDir, profileId) {
  return path.join(instanceRoot(minecraftDir), profileId);
}

function instanceModsDir(minecraftDir, profileId) {
  return path.join(instanceDir(minecraftDir, profileId), 'mods');
}

function customModsPath(launcherRoot, profileId) {
  return path.join(launcherRoot, 'custom-mods', `${profileId}.json`);
}

function readProfileCustomMods(launcherRoot, profileId) {
  const filePath = customModsPath(launcherRoot, profileId);
  const legacy = readJson(path.join(launcherRoot, 'custom-mods.json'), { mods: [] });
  const scoped = readJson(filePath, null);
  if (scoped) {
    return scoped;
  }
  if (profileId === 'bloodpact-1.21' && legacy.mods?.length) {
    writeJson(filePath, legacy);
    return legacy;
  }
  return { mods: [] };
}

function writeProfileCustomMods(launcherRoot, profileId, data) {
  writeJson(customModsPath(launcherRoot, profileId), data);
}

const ESSENTIAL_MODRINTH_ID = 'k2ZPuTBm';

function isVanillaModpack(modpack) {
  return (modpack?.loader || 'fabric') === 'vanilla';
}

function shouldIncludeEssential(modpack) {
  return !modpack?.skipEssential;
}

function isEssentialMod(mod) {
  return mod?.essential === true || mod?.id === 'essential';
}

function isModLocked(mod, modpack) {
  if (!mod || isVanillaModpack(modpack)) {
    return false;
  }
  if (isEssentialMod(mod) && !shouldIncludeEssential(modpack)) {
    return false;
  }
  return Boolean(mod.required || isEssentialMod(mod));
}

function isModEnabled(mod, enabledMods = {}, modpack) {
  if (isModLocked(mod, modpack)) {
    return true;
  }
  if (mod.required) {
    return true;
  }
  return enabledMods[mod.id] !== false;
}

function getDefaultModEnabled(mod, modpack) {
  if (isModLocked(mod, modpack)) {
    return true;
  }
  return mod.required || mod.defaultEnabled !== false;
}

function createEssentialModEntry() {
  return {
    id: 'essential',
    name: 'Essential',
    category: 'core',
    required: true,
    essential: true,
    source: 'modrinth',
    projectId: ESSENTIAL_MODRINTH_ID,
    fallbackFilename: 'essential'
  };
}

function enforceEssentialMods(config, modpacks) {
  for (const modpack of modpacks) {
    if (isVanillaModpack(modpack) || !shouldIncludeEssential(modpack)) {
      continue;
    }
    if (!config.profiles?.[modpack.id]) {
      continue;
    }
    config.profiles[modpack.id].enabledMods = config.profiles[modpack.id].enabledMods || {};
    for (const mod of modpack.mods || []) {
      if (isModLocked(mod, modpack)) {
        config.profiles[modpack.id].enabledMods[mod.id] = true;
      }
    }
  }
  return config;
}

module.exports = {
  listModpacks,
  loadModpack,
  resolveProfile,
  migrateLegacyProfile,
  getSelectedProfileId,
  instanceDir,
  instanceModsDir,
  instanceRoot,
  readProfileCustomMods,
  writeProfileCustomMods,
  customModsPath,
  ESSENTIAL_MODRINTH_ID,
  createEssentialModEntry,
  enforceEssentialMods,
  getDefaultModEnabled,
  isEssentialMod,
  isModEnabled,
  isModLocked,
  isVanillaModpack,
  shouldIncludeEssential
};
