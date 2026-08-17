const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  findBundledNodeExecutable,
  findBundledNpmCli
} = require('./src/bundledRuntime');

const launcherRoot = __dirname;
const logFile = path.join(launcherRoot, 'bloodpact-launcher.log');

function ensureAssets() {
  const assetsDir = path.join(launcherRoot, 'assets');
  const iconDest = path.join(assetsDir, 'icon.png');
  const logoDest = path.join(assetsDir, 'logo.png');
  const iconCandidates = [
    path.join(launcherRoot, 'assets', 'bloodpact-logo.png'),
    path.join(launcherRoot, '..', 'src', 'main', 'resources', 'assets', 'bloodpact', 'icon.png')
  ];
  fs.mkdirSync(assetsDir, { recursive: true });

  for (const candidate of iconCandidates) {
    if (candidate.endsWith('.png') && fs.existsSync(candidate)) {
      if (!fs.existsSync(iconDest)) {
        fs.copyFileSync(candidate, iconDest);
      }
      if (!fs.existsSync(logoDest)) {
        fs.copyFileSync(candidate, logoDest);
      }
      break;
    }
  }
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch {
    // ignore log write failures
  }
  console.log(message);
}

function resolveNodeExecutable() {
  return findBundledNodeExecutable(launcherRoot) || process.execPath;
}

function hasDependencies() {
  return fs.existsSync(path.join(launcherRoot, 'node_modules', 'electron', 'cli.js'));
}

function buildSpawnEnv() {
  const bundledNode = findBundledNodeExecutable(launcherRoot);
  if (!bundledNode) {
    return process.env;
  }

  const nodeDir = path.dirname(bundledNode);
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const currentPath = process.env[pathKey] || '';
  return {
    ...process.env,
    [pathKey]: `${nodeDir}${path.delimiter}${currentPath}`
  };
}

function runNpmInstall() {
  log('Running npm install...');
  console.log('Downloading launcher dependencies (first launch may take 1-3 minutes)...');
  const nodeExe = resolveNodeExecutable();
  const npmCli = findBundledNpmCli(launcherRoot);
  log(`Using Node: ${nodeExe}`);

  let result;
  if (npmCli) {
    log(`Using npm-cli: ${npmCli}`);
    result = spawnSync(nodeExe, [npmCli, 'install', '--no-audit', '--no-fund'], {
      cwd: launcherRoot,
      stdio: 'inherit',
      env: buildSpawnEnv(),
      shell: false
    });
  } else {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    log(`Using npm: ${npmCmd}`);
    result = spawnSync(npmCmd, ['install', '--no-audit', '--no-fund'], {
      cwd: launcherRoot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: buildSpawnEnv()
    });
  }

  if (result.error) {
    log(`npm spawn error: ${result.error.message}`);
  }
  if (result.status !== 0) {
    log(`npm install failed with code ${result.status}, signal ${result.signal || 'none'}`);
    console.error('');
    console.error('npm install failed.');
    if (result.error) {
      console.error(result.error.message);
    }
    console.error('Try FIX-BLOODPACT.bat or delete launcher\\node_modules and run 2-Open-BloodPact.bat again.');
    console.error(`Details: ${logFile}`);
    console.error('');
    process.exit(result.status || 1);
  }
  log('npm install complete');
}

function isProcessAlive(pid) {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // wait for Electron to start or fail fast
  }
}

function launchElectron() {
  const electronCli = path.join(launcherRoot, 'node_modules', 'electron', 'cli.js');
  if (!fs.existsSync(electronCli)) {
    console.error('');
    console.error('ERROR: Electron is not installed.');
    console.error('Run FIX-BLOODPACT.bat or delete launcher\\node_modules and try again.');
    console.error(`Details: ${logFile}`);
    console.error('');
    process.exit(1);
  }

  const nodeExe = resolveNodeExecutable();
  log(`Launching Electron via ${nodeExe}`);

  let logFd;
  try {
    logFd = fs.openSync(logFile, 'a');
  } catch {
    logFd = 'ignore';
  }

  const child = spawn(nodeExe, [electronCli, '.'], {
    cwd: launcherRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: buildSpawnEnv(),
    windowsHide: false
  });

  child.on('error', (error) => {
    log(`Electron spawn error: ${error.stack || error.message}`);
    console.error('');
    console.error('Could not start BloodPact window:', error.message);
    console.error(`Details: ${logFile}`);
    process.exit(1);
  });

  child.unref();
  if (typeof logFd === 'number') {
    try {
      fs.closeSync(logFd);
    } catch {
      // ignore
    }
  }

  sleep(2500);
  if (!isProcessAlive(child.pid)) {
    log(`Electron exited immediately (pid ${child.pid})`);
    console.error('');
    console.error('BloodPact window closed right after opening.');
    console.error(`Open this file for details: ${logFile}`);
    console.error('Try FIX-BLOODPACT.bat, or run 2-Open-BloodPact.bat again with internet.');
    console.error('');
    process.exit(1);
  }

  log(`Electron started (pid ${child.pid})`);
}

try {
  log('BloodPact bootstrap starting');
  ensureAssets();
  if (!hasDependencies()) {
    runNpmInstall();
  }
  if (!hasDependencies()) {
    console.error('');
    console.error('ERROR: Launcher dependencies are still missing after npm install.');
    console.error(`Details: ${logFile}`);
    process.exit(1);
  }
  launchElectron();
} catch (error) {
  log(error.stack || String(error));
  console.error(error);
  process.exit(1);
}
