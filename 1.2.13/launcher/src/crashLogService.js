const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { instanceDir } = require('./modpackRegistry');

function crashReportsDir(minecraftDir, profileId) {
  return path.join(instanceDir(minecraftDir, profileId), 'crash-reports');
}

function crashLogArchiveDir(launcherRoot) {
  return path.join(launcherRoot, 'crash-logs');
}

function listCrashReports(minecraftDir, profileId) {
  const dir = crashReportsDir(minecraftDir, profileId);
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.txt'))
    .map((name) => {
      const fullPath = path.join(dir, name);
      const stats = fs.statSync(fullPath);
      return {
        name,
        path: fullPath,
        mtimeMs: stats.mtimeMs,
        size: stats.size
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readCrashReport(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, 'utf8');
}

function summarizeCrashReport(text) {
  if (!text) {
    return null;
  }

  const descriptionMatch = text.match(/^Description: (.+)$/m);
  const timeMatch = text.match(/^Time: (.+)$/m);
  const exceptionLine = text
    .split(/\r?\n/)
    .find((line) => /Exception:|Error:/i.test(line) && !line.startsWith('\t'));

  return {
    time: timeMatch?.[1] || null,
    description: descriptionMatch?.[1] || 'Minecraft crashed',
    exception: exceptionLine?.trim() || null
  };
}

function archiveCrashReport(launcherRoot, profileId, reportPath) {
  if (!reportPath || !fs.existsSync(reportPath)) {
    return null;
  }

  const archiveDir = path.join(crashLogArchiveDir(launcherRoot), profileId);
  fs.mkdirSync(archiveDir, { recursive: true });

  const baseName = path.basename(reportPath, '.txt');
  const archivedPath = path.join(archiveDir, `${baseName}.txt`);
  if (!fs.existsSync(archivedPath)) {
    fs.copyFileSync(reportPath, archivedPath);
  }

  return archivedPath;
}

function getLatestCrashInfo(launcherRoot, minecraftDir, profileId) {
  const reports = listCrashReports(minecraftDir, profileId);
  if (!reports.length) {
    return null;
  }

  const latest = reports[0];
  const text = readCrashReport(latest.path);
  const summary = summarizeCrashReport(text);
  const archivedPath = archiveCrashReport(launcherRoot, profileId, latest.path);

  return {
    profileId,
    name: latest.name,
    path: latest.path,
    archivedPath,
    mtimeMs: latest.mtimeMs,
    summary,
    preview: text ? text.split(/\r?\n/).slice(0, 12).join('\n') : ''
  };
}

function openCrashReport(reportPath) {
  if (!reportPath || !fs.existsSync(reportPath)) {
    return { ok: false, error: 'Crash report not found' };
  }
  shell.showItemInFolder(reportPath);
  return { ok: true, path: reportPath };
}

module.exports = {
  archiveCrashReport,
  crashLogArchiveDir,
  crashReportsDir,
  getLatestCrashInfo,
  listCrashReports,
  openCrashReport,
  readCrashReport,
  summarizeCrashReport
};
