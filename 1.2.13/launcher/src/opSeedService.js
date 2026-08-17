const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('./modManager');

const CATALOG_REL = path.join('op-seeds', 'catalog.json');
const SELECTED_SEED_FILE = 'bloodpact-selected-seed.json';
const INSTANCE_CATALOG_FILE = 'bloodpact-op-seeds.json';

function catalogPath(launcherRoot) {
  return path.join(launcherRoot, CATALOG_REL);
}

function loadCatalog(launcherRoot) {
  const catalog = readJson(catalogPath(launcherRoot), { version: 1, seeds: [] });
  return {
    version: catalog.version || 1,
    seeds: Array.isArray(catalog.seeds) ? catalog.seeds : []
  };
}

function findSeed(catalog, seedId) {
  if (!seedId) {
    return null;
  }
  return catalog.seeds.find((entry) => entry.id === seedId) || null;
}

function normalizeCustomSeed(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }
  if (!/^-?\d+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function resolveSelectedSeed(config, launcherRoot) {
  const catalog = loadCatalog(launcherRoot);
  const custom = normalizeCustomSeed(config.customOpSeed);
  if (custom) {
    return {
      id: 'custom',
      name: 'Custom OP Seed',
      seed: custom,
      description: 'Custom seed from launcher settings.',
      source: 'custom',
      highlights: []
    };
  }
  const picked = findSeed(catalog, config.selectedOpSeedId);
  if (picked) {
    return { ...picked, source: 'catalog' };
  }
  return null;
}

function writeSeedFiles(gameDir, config, launcherRoot) {
  const catalog = loadCatalog(launcherRoot);
  const selected = resolveSelectedSeed(config, launcherRoot);

  fs.mkdirSync(gameDir, { recursive: true });
  writeJson(path.join(gameDir, INSTANCE_CATALOG_FILE), catalog);

  const selectedPath = path.join(gameDir, SELECTED_SEED_FILE);
  if (selected?.seed) {
    const payload = {
      id: selected.id,
      name: selected.name,
      seed: selected.seed,
      description: selected.description || '',
      tags: selected.tags || [],
      startLabel: selected.startLabel || '',
      highlights: selected.highlights || [],
      coordsLine: formatCoordsLine(selected),
      updatedAt: new Date().toISOString()
    };
    if (selected.startX != null) {
      payload.startX = selected.startX;
    }
    if (selected.startZ != null) {
      payload.startZ = selected.startZ;
    }
    writeJson(selectedPath, payload);
  } else if (fs.existsSync(selectedPath)) {
    try {
      fs.unlinkSync(selectedPath);
    } catch {
      // ignore cleanup errors
    }
  }
}

function formatCoordsLine(entry) {
  if (!entry) {
    return '';
  }
  if (entry.coordsLine) {
    return entry.coordsLine;
  }
  if (entry.startX != null && entry.startZ != null && !(entry.startX === 0 && entry.startZ === 0)) {
    return `X ${entry.startX} Z ${entry.startZ}`;
  }
  if (Array.isArray(entry.highlights) && entry.highlights.length > 0) {
    const highlight = entry.highlights[0];
    return `${highlight.label} — X ${highlight.x} Z ${highlight.z}`;
  }
  return 'Near world spawn';
}

function mergeDiscoveredCoords(catalog, gameDir) {
  if (!gameDir) {
    return catalog;
  }
  const selectedPath = path.join(gameDir, SELECTED_SEED_FILE);
  const discovered = readJson(selectedPath, null);
  if (!discovered?.id || !discovered.coordsLine) {
    return catalog;
  }
  return catalog.map((entry) => {
    if (entry.id !== discovered.id) {
      return entry;
    }
    return {
      ...entry,
      startX: discovered.startX ?? entry.startX,
      startZ: discovered.startZ ?? entry.startZ,
      startLabel: discovered.startLabel || entry.startLabel,
      coordsLine: discovered.coordsLine || entry.coordsLine,
      highlights: discovered.highlights || entry.highlights
    };
  });
}

function listSeedsForUi(launcherRoot, config, gameDir) {
  const catalog = loadCatalog(launcherRoot);
  const mergedCatalog = mergeDiscoveredCoords(catalog.seeds, gameDir).map((entry) => ({
    ...entry,
    coordsLine: formatCoordsLine(entry)
  }));
  const selected = resolveSelectedSeed(config, launcherRoot);
  const active = selected
    ? {
        ...selected,
        coordsLine: formatCoordsLine(selected)
      }
    : null;
  return {
    catalog: mergedCatalog,
    selectedOpSeedId: config.selectedOpSeedId || '',
    customOpSeed: config.customOpSeed || '',
    active
  };
}

function selectCatalogSeed(launcherRoot, seedId) {
  const configPath = path.join(launcherRoot, 'config.json');
  const config = readJson(configPath, {});
  const catalog = loadCatalog(launcherRoot);
  if (seedId && !findSeed(catalog, seedId)) {
    return { ok: false, error: 'Unknown seed pack.' };
  }
  config.selectedOpSeedId = seedId || '';
  if (seedId) {
    config.customOpSeed = '';
  }
  writeJson(configPath, config);
  return { ok: true, config, active: resolveSelectedSeed(config, launcherRoot) };
}

function setCustomSeed(launcherRoot, seedValue) {
  const configPath = path.join(launcherRoot, 'config.json');
  const config = readJson(configPath, {});
  const normalized = normalizeCustomSeed(seedValue);
  if (seedValue && !normalized) {
    return { ok: false, error: 'Custom seed must be a whole number (digits only).' };
  }
  config.customOpSeed = normalized || '';
  if (normalized) {
    config.selectedOpSeedId = '';
  }
  writeJson(configPath, config);
  return { ok: true, config, active: resolveSelectedSeed(config, launcherRoot) };
}

function clearSelectedSeed(launcherRoot) {
  const configPath = path.join(launcherRoot, 'config.json');
  const config = readJson(configPath, {});
  config.selectedOpSeedId = '';
  config.customOpSeed = '';
  writeJson(configPath, config);
  return { ok: true, config, active: null };
}

module.exports = {
  loadCatalog,
  listSeedsForUi,
  resolveSelectedSeed,
  writeSeedFiles,
  selectCatalogSeed,
  setCustomSeed,
  clearSelectedSeed
};
