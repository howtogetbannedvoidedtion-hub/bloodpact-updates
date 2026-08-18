const fs = require('fs');
const path = require('path');

const FIRST_LAUNCH_OPTIONS = {
  renderDistance: '8',
  simulationDistance: '6',
  maxFps: '60',
  enableVsync: 'false',
  graphicsPreset: '"fast"',
  entityShadows: 'false',
  particles: '2',
  renderClouds: '"false"',
  entityDistanceScaling: '0.5',
  biomeBlendRadius: '1'
};

const LOW_RAM_LAUNCH_OPTIONS = {
  renderDistance: '6',
  simulationDistance: '4',
  maxFps: '60',
  enableVsync: 'false',
  graphicsPreset: '"fast"',
  entityShadows: 'false',
  particles: '1',
  renderClouds: '"false"',
  entityDistanceScaling: '0.35',
  biomeBlendRadius: '0',
  mipmapLevels: '0'
};

function patchOptionsFile(optionsPath, patches) {
  const lines = fs.existsSync(optionsPath)
    ? fs.readFileSync(optionsPath, 'utf8').split(/\r?\n/)
    : [];
  const values = new Map();

  for (const line of lines) {
    if (!line || line.startsWith('#')) {
      continue;
    }
    const splitAt = line.indexOf(':');
    if (splitAt <= 0) {
      continue;
    }
    values.set(line.slice(0, splitAt), line.slice(splitAt + 1));
  }

  for (const [key, value] of Object.entries(patches)) {
    values.set(key, value);
  }

  const output = [...values.entries()].map(([key, value]) => `${key}:${value}`).join('\n');
  fs.writeFileSync(optionsPath, `${output}\n`, 'utf8');
}

function seedPerformanceDefaults(gameDir, options = {}) {
  if (!gameDir) {
    return false;
  }

  const lowRam = options.lowRam === true;
  const marker = path.join(gameDir, lowRam ? '.bloodpact-perf-seeded-lite' : '.bloodpact-perf-seeded');
  if (fs.existsSync(marker)) {
    return false;
  }

  fs.mkdirSync(gameDir, { recursive: true });
  patchOptionsFile(
    path.join(gameDir, 'options.txt'),
    lowRam ? LOW_RAM_LAUNCH_OPTIONS : FIRST_LAUNCH_OPTIONS
  );
  fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
  return true;
}

module.exports = {
  seedPerformanceDefaults,
  FIRST_LAUNCH_OPTIONS,
  LOW_RAM_LAUNCH_OPTIONS
};
