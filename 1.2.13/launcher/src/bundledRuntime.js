const fs = require('fs');
const path = require('path');

function getBloodpactRoot(fromLauncherDir) {
  return path.resolve(fromLauncherDir, '..');
}

function getRuntimeDir(fromLauncherDir) {
  return path.join(getBloodpactRoot(fromLauncherDir), 'tools', 'runtime');
}

function findFileRecursive(rootDir, fileName, maxDepth = 4) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return null;
  }

  const queue = [{ dir: rootDir, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
        return fullPath;
      }
      if (entry.isDirectory() && depth < maxDepth) {
        queue.push({ dir: fullPath, depth: depth + 1 });
      }
    }
  }

  return null;
}

function findBundledNodeExecutable(fromLauncherDir) {
  const nodeDir = path.join(getRuntimeDir(fromLauncherDir), 'node');
  const direct = path.join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node');
  if (fs.existsSync(direct)) {
    return direct;
  }
  return findFileRecursive(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node');
}

function findBundledNpmExecutable(fromLauncherDir) {
  const nodeDir = path.join(getRuntimeDir(fromLauncherDir), 'node');
  const npmName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const direct = path.join(nodeDir, npmName);
  if (fs.existsSync(direct)) {
    return direct;
  }
  return findFileRecursive(nodeDir, npmName);
}

function findBundledNpmCli(fromLauncherDir) {
  const bundledNode = findBundledNodeExecutable(fromLauncherDir);
  if (!bundledNode) {
    return null;
  }
  const nodeDir = path.dirname(bundledNode);
  const direct = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(direct)) {
    return direct;
  }
  return findFileRecursive(nodeDir, 'npm-cli.js');
}

function findBundledJavaExecutable(fromLauncherDir, javaMajor = 21) {
  const javaRoot = path.join(getRuntimeDir(fromLauncherDir), 'java');
  if (!fs.existsSync(javaRoot)) {
    return null;
  }

  const patterns = {
    8: /jdk-?1\.8|jdk-?8|jre-?1\.8|jre-?8/i,
    17: /jdk-?17|jre-?17/i,
    21: /jdk-?21|jre-?21/i,
    25: /jdk-?25|jre-?25/i
  };
  const pattern = patterns[javaMajor] || new RegExp(`jdk-?${javaMajor}|jre-?${javaMajor}`, 'i');
  const matches = [];

  const scanDir = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const fullDir = path.join(dir, entry.name);
      const javaExe = path.join(fullDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      if (fs.existsSync(javaExe) && pattern.test(entry.name)) {
        matches.push(javaExe);
      }
      if (entry.name === `jdk-${javaMajor}` || entry.name.startsWith(`jdk-${javaMajor}.`)) {
        scanDir(fullDir);
      }
    }
  };

  scanDir(javaRoot);
  return matches.sort().reverse()[0] || null;
}

function bundledRuntimesPresent(fromLauncherDir) {
  return Boolean(findBundledNodeExecutable(fromLauncherDir) && findBundledJavaExecutable(fromLauncherDir, 25));
}

module.exports = {
  bundledRuntimesPresent,
  findBundledJavaExecutable,
  findBundledNodeExecutable,
  findBundledNpmExecutable,
  findBundledNpmCli,
  getBloodpactRoot,
  getRuntimeDir
};
