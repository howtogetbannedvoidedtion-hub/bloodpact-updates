const usernameInput = document.getElementById('username');
const accountUsernameInput = document.getElementById('account-username');
const memorySelect = document.getElementById('memory');
const memoryNoteEl = document.getElementById('memory-note');
const javaPathEl = document.getElementById('java-path');
const playBtn = document.getElementById('play-btn');
const statusEl = document.getElementById('status');
const launchSummaryEl = document.getElementById('launch-summary');
const modCategoriesEl = document.getElementById('mod-categories');
const localModListEl = document.getElementById('local-mod-list');
const minecraftPathEl = document.getElementById('minecraft-path');
const splashEl = document.getElementById('splash');
const appEl = document.getElementById('app');
const splashTextEl = document.getElementById('splash-text');
const modSearchForm = document.getElementById('mod-search-form');
const modSearchQueryInput = document.getElementById('mod-search-query');
const modBrowseStatusEl = document.getElementById('mod-browse-status');
const modBrowseResultsEl = document.getElementById('mod-browse-results');
const browseTitleEl = document.getElementById('browse-title');
const browseCopyEl = document.getElementById('browse-copy');
const sourceTabs = document.querySelectorAll('.source-tab');
const curseForgeApiKeyInput = document.getElementById('curseforge-api-key');
const customModListEl = document.getElementById('custom-mod-list');
const launchProfileSelectEl = document.getElementById('launch-profile-select');
const headerTagEl = document.getElementById('header-tag');
const mcVersionEl = document.getElementById('mc-version');
const loaderTagEl = document.getElementById('loader-tag');
const heroEyebrowEl = document.getElementById('hero-eyebrow');
const heroTitleEl = document.getElementById('hero-title');
const heroCopyEl = document.getElementById('hero-copy');
const heroTagsEl = document.getElementById('hero-tags');
const modsPanelTitleEl = document.getElementById('mods-panel-title');
const modsPanelCopyEl = document.getElementById('mods-panel-copy');
const crashLogSummaryEl = document.getElementById('crash-log-summary');
const crashLogPreviewEl = document.getElementById('crash-log-preview');
const openCrashLogBtn = document.getElementById('open-crash-log-btn');
const crashAlertEl = document.getElementById('crash-alert');
const crashAlertTextEl = document.getElementById('crash-alert-text');
const crashAlertOpenBtn = document.getElementById('crash-alert-open');
const updateBannerEl = document.getElementById('update-banner');
const updateBannerTitleEl = document.getElementById('update-banner-title');
const updateBannerCopyEl = document.getElementById('update-banner-copy');
const installUpdateBtn = document.getElementById('install-update-btn');
const packVersionLabelEl = document.getElementById('pack-version-label');
const updateStatusTextEl = document.getElementById('update-status-text');
const checkUpdatesBtn = document.getElementById('check-updates-btn');
const settingsInstallUpdateBtn = document.getElementById('settings-install-update-btn');
const opSeedSelectEl = document.getElementById('op-seed-select');
const customOpSeedInput = document.getElementById('custom-op-seed');
const opSeedDescriptionEl = document.getElementById('op-seed-description');
const clearOpSeedBtn = document.getElementById('clear-op-seed-btn');
const copyOpSeedBtn = document.getElementById('copy-op-seed-btn');

let currentState = null;
let browseLoaded = false;
let activeModSource = 'modrinth';
let latestUpdateCheck = null;

const SOURCE_META = {
  modrinth: {
    title: 'Browse Modrinth',
    copy: 'Search open-source mods on Modrinth for your Minecraft version.',
    placeholder: 'Search Modrinth… e.g. sodium, voice chat, minimap',
    defaultQuery: 'optimization',
    linkLabel: 'Modrinth'
  },
  curseforge: {
    title: 'Browse CurseForge',
    copy: 'Search CurseForge mods. Add your API key in Settings first.',
    placeholder: 'Search CurseForge… e.g. jei, create, journey map',
    defaultQuery: 'performance',
    linkLabel: 'CurseForge'
  },
  free: {
    title: 'Free Picks',
    copy: 'Curated free mods that work well with PvP and performance — no account needed.',
    placeholder: 'Filter free picks… e.g. sodium, zoom, fps',
    defaultQuery: '',
    linkLabel: 'View'
  }
};

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

function renderOpSeeds(opSeeds) {
  if (!opSeedSelectEl || !opSeeds) {
    return;
  }

  const catalog = opSeeds.catalog || [];
  const previous = opSeedSelectEl.value;
  opSeedSelectEl.innerHTML = '';

  const noneOption = document.createElement('option');
  noneOption.value = '';
  noneOption.textContent = 'Random world (no preset)';
  opSeedSelectEl.appendChild(noneOption);

  for (const entry of catalog) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.name;
    opSeedSelectEl.appendChild(option);
  }

  const listEl = document.getElementById('op-seed-list');
  if (listEl) {
    listEl.innerHTML = '';
    for (const entry of catalog) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'op-seed-row';
      if (opSeeds.selectedOpSeedId === entry.id && !opSeeds.customOpSeed) {
        row.classList.add('active');
      }
      row.dataset.seedId = entry.id;
      row.innerHTML = `<span class="op-seed-name">${entry.name}</span><span class="op-seed-coords">${formatCoordsLine(entry)}</span>`;
      row.addEventListener('click', async () => {
        const result = await window.bloodpact.selectOpSeed(entry.id);
        if (!result.ok) {
          setStatus(result.error || 'Could not save seed', 'error');
          return;
        }
        await refreshState(false);
        setStatus(`Selected ${entry.name}`, 'ok');
      });
      listEl.appendChild(row);
    }
  }

  if (opSeeds.customOpSeed) {
    customOpSeedInput.value = opSeeds.customOpSeed;
    opSeedSelectEl.value = '';
  } else {
    customOpSeedInput.value = '';
    opSeedSelectEl.value = opSeeds.selectedOpSeedId || previous || '';
  }

  updateOpSeedDescription(opSeeds);
}

function updateOpSeedDescription(opSeeds) {
  if (!opSeedDescriptionEl) {
    return;
  }
  const active = opSeeds?.active;
  if (!active?.seed) {
    opSeedDescriptionEl.textContent = 'No seed selected — singleplayer uses random worlds.';
    return;
  }
  opSeedDescriptionEl.textContent = `${active.name} — ${formatCoordsLine(active)} · ${active.description || 'Selected for next new world.'}`;
}

async function copyActiveSeedToClipboard() {
  const active = currentState?.opSeeds?.active;
  const seed = active?.seed || customOpSeedInput?.value?.trim();
  if (!seed) {
    setStatus('Pick or enter a seed first', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(seed);
    setStatus(`Copied seed ${seed}`, 'ok');
  } catch {
    setStatus('Could not copy seed to clipboard', 'error');
  }
}

function formatDownloads(count) {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M downloads`;
  }
  if (count >= 1000) {
    return `${Math.round(count / 1000)}K downloads`;
  }
  return `${count} downloads`;
}

function isHitInstalled(hit) {
  const customMods = currentState?.customMods || [];
  if (hit.source === 'curseforge') {
    return customMods.some((mod) => String(mod.curseforgeModId) === String(hit.id));
  }
  if (hit.source === 'free') {
    if (hit.installSource === 'curseforge') {
      return customMods.some((mod) => String(mod.curseforgeModId) === String(hit.curseforgeModId));
    }
    return customMods.some((mod) => mod.projectId === hit.projectId);
  }
  return customMods.some((mod) => mod.projectId === hit.id || mod.projectId === hit.projectId);
}

function sourceBadgeLabel(source) {
  if (source === 'curseforge') {
    return 'CurseForge';
  }
  if (source === 'free') {
    return 'Free';
  }
  return 'Modrinth';
}

function updateBrowseChrome() {
  const meta = SOURCE_META[activeModSource] || SOURCE_META.modrinth;
  if (browseTitleEl) {
    browseTitleEl.textContent = meta.title;
  }
  if (browseCopyEl) {
    browseCopyEl.textContent = meta.copy;
  }
  if (modSearchQueryInput) {
    modSearchQueryInput.placeholder = meta.placeholder;
  }
}

function formatDownloadSize(bytes) {
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

function renderUpdateUi(check) {
  latestUpdateCheck = check;
  const localVersion = currentState?.packVersion || check?.localVersion || '0.0.0';

  if (packVersionLabelEl) {
    packVersionLabelEl.textContent = `Pack v${localVersion}`;
  }

  const showInstall = check?.status === 'available';
  if (updateBannerEl) {
    updateBannerEl.classList.toggle('hidden', !showInstall);
  }
  if (installUpdateBtn) {
    installUpdateBtn.classList.toggle('hidden', !showInstall);
  }
  if (settingsInstallUpdateBtn) {
    settingsInstallUpdateBtn.classList.toggle('hidden', !showInstall);
  }

  if (showInstall) {
    const sizeLabel = formatDownloadSize(check.pendingBytes);
    const title = `Update v${check.remoteVersion} available`;
    const copy = check.changelog
      ? `${check.changelog} (${sizeLabel})`
      : `${check.pendingCount} file(s) ready to download (${sizeLabel}).`;
    if (updateBannerTitleEl) {
      updateBannerTitleEl.textContent = title;
    }
    if (updateBannerCopyEl) {
      updateBannerCopyEl.textContent = copy;
    }
    if (updateStatusTextEl) {
      updateStatusTextEl.textContent = copy;
    }
    return;
  }

  let statusText = 'BloodPact is up to date.';
  if (check?.status === 'disabled') {
    statusText = check.reason || 'Cloud updates are not configured — you can still play normally.';
  } else if (check?.status === 'error') {
    statusText = check.reason || 'Update check failed — you can still play.';
  } else if (check?.status === 'current') {
    statusText = `You are on the latest pack (v${check.remoteVersion || localVersion}).`;
  }

  if (updateStatusTextEl) {
    updateStatusTextEl.textContent = statusText;
  }
}

async function runUpdateCheck(showStatus = false) {
  if (showStatus) {
    setStatus('Checking for BloodPact updates...');
  }
  if (updateStatusTextEl) {
    updateStatusTextEl.textContent = 'Checking for updates...';
  }

  try {
    const check = await window.bloodpact.checkUpdates();
    renderUpdateUi(check);
    if (showStatus) {
      if (check.status === 'available') {
        setStatus(`Update v${check.remoteVersion} available (${formatDownloadSize(check.pendingBytes)})`, 'ok');
      } else if (check.status === 'error') {
        setStatus(check.reason || 'Update check failed — you can still play.', 'error');
      } else {
        setStatus('BloodPact is up to date', 'ok');
      }
    }
    return check;
  } catch (error) {
    renderUpdateUi({ status: 'error', reason: error.message });
    if (showStatus) {
      setStatus(`Update check failed: ${error.message}`, 'error');
    }
    throw error;
  }
}

async function installCloudUpdate() {
  setStatus('Downloading update files...');
  if (installUpdateBtn) {
    installUpdateBtn.disabled = true;
  }
  if (settingsInstallUpdateBtn) {
    settingsInstallUpdateBtn.disabled = true;
  }

  try {
    const result = await window.bloodpact.applyUpdates();
    if (result.status === 'updated') {
      setStatus(result.message || 'Update installed. Restart BloodPact to use the new files.', 'ok');
      await refreshState(false);
      await runUpdateCheck(false);
    } else if (result.status === 'current') {
      setStatus(result.message || 'Already up to date', 'ok');
      renderUpdateUi(result);
    } else if (result.status === 'error') {
      setStatus(result.reason || 'Update failed', 'error');
      renderUpdateUi(result);
    } else {
      setStatus(result.reason || 'Updates are not configured', 'error');
      renderUpdateUi(result);
    }
  } catch (error) {
    setStatus(`Update failed: ${error.message}`, 'error');
  } finally {
    if (installUpdateBtn) {
      installUpdateBtn.disabled = false;
    }
    if (settingsInstallUpdateBtn) {
      settingsInstallUpdateBtn.disabled = false;
    }
  }
}

function setActiveModSource(source) {
  activeModSource = source;
  sourceTabs.forEach((tab) => {
    const selected = tab.dataset.source === source;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  updateBrowseChrome();
}

function showApp() {
  splashEl.classList.add('hidden');
  appEl.classList.remove('hidden');
}

function setStatus(message, type = '') {
  statusEl.textContent = message;
  statusEl.className = `status-line ${type}`.trim();
}

function setSummary(items) {
  launchSummaryEl.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    launchSummaryEl.appendChild(li);
  }
}

function setupTabs() {
  const tabs = document.querySelectorAll('.meteor-tab');
  const panels = document.querySelectorAll('.panel');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((node) => {
        node.classList.remove('active');
        node.setAttribute('aria-selected', 'false');
      });
      panels.forEach((node) => node.classList.remove('active'));
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      document.querySelector(`[data-panel="${tab.dataset.tab}"]`)?.classList.add('active');
      if (tab.dataset.tab === 'browse' && !browseLoaded) {
        browseLoaded = true;
        runModSearch(SOURCE_META[activeModSource].defaultQuery || 'optimization');
      }
    });
  });
}

function renderBrowseResults(hits, source) {
  modBrowseResultsEl.innerHTML = '';
  const version = currentState?.profile?.modpack?.minecraftVersion || '1.21';
  const loader = currentState?.profile?.modpack?.loader || 'fabric';

  if (!hits.length) {
    modBrowseResultsEl.innerHTML = `<div class="empty-state">No ${loader} ${version} mods matched that search.</div>`;
    return;
  }

  for (const hit of hits) {
    const card = document.createElement('article');
    card.className = `mod-browse-card source-${hit.source || source}`;

    let icon;
    if (hit.iconUrl) {
      icon = document.createElement('img');
      icon.className = 'mod-browse-icon';
      icon.src = hit.iconUrl;
      icon.alt = '';
    } else {
      icon = document.createElement('div');
      icon.className = 'mod-browse-icon placeholder';
      icon.textContent = hit.name.slice(0, 1).toUpperCase();
    }

    const info = document.createElement('div');
    info.className = 'mod-browse-info';
    const downloads = hit.downloads ? `${formatDownloads(hit.downloads)} • ` : '';
    info.innerHTML = `
      <strong>${hit.name}</strong>
      <p>${hit.description || 'No description'}</p>
      <div class="mod-browse-meta">
        <span class="source-badge ${hit.source || source}">${sourceBadgeLabel(hit.source || source)}</span>
        ${downloads}${loader} ${version}
      </div>
    `;

    const actions = document.createElement('div');
    actions.className = 'mod-browse-actions';

    const installed = isHitInstalled(hit);
    const addBtn = document.createElement('button');
    addBtn.className = `mod-browse-add-btn${installed ? ' installed' : ''}`;
    addBtn.textContent = installed ? 'Added' : 'Add';
    addBtn.disabled = installed;
    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true;
      addBtn.textContent = 'Adding…';
      modBrowseStatusEl.className = 'browse-status';
      modBrowseStatusEl.textContent = `Installing ${hit.name}…`;
      try {
        const installSource = hit.source === 'free'
          ? 'free'
          : (source === 'modrinth' || hit.fallbackSource ? 'modrinth' : (hit.source || source));
        const installId = hit.source === 'free' ? hit.catalogId || hit.id : (hit.projectId || hit.id);
        const result = await window.bloodpact.installCustomMod(installSource, installId);
        const depText = result.dependencies?.length
          ? ` (+ ${result.dependencies.join(', ')})`
          : '';
        modBrowseStatusEl.textContent = result.alreadyInstalled
          ? `${result.mod.name} is already added`
          : `Added ${result.mod.name} v${result.mod.version}${depText}`;
        await refreshState(false);
        renderBrowseResults(hits, source);
      } catch (error) {
        modBrowseStatusEl.className = 'browse-status error';
        modBrowseStatusEl.textContent = `Could not add ${hit.name}: ${error.message}`;
        addBtn.disabled = false;
        addBtn.textContent = 'Add';
      }
    });

    const linkBtn = document.createElement('button');
    linkBtn.className = 'mod-browse-link-btn';
    linkBtn.textContent = SOURCE_META[hit.source || source]?.linkLabel || 'Open';
    linkBtn.disabled = !hit.url;
    linkBtn.addEventListener('click', () => {
      if (hit.url) {
        window.bloodpact.openExternal(hit.url);
      }
    });

    actions.appendChild(addBtn);
    actions.appendChild(linkBtn);
    card.appendChild(icon);
    card.appendChild(info);
    card.appendChild(actions);
    modBrowseResultsEl.appendChild(card);
  }
}

function renderCustomMods(customMods) {
  customModListEl.innerHTML = '';

  if (!customMods.length) {
    customModListEl.innerHTML = '<div class="empty-state">No extra mods yet. Browse Modrinth, CurseForge, or Free Picks above.</div>';
    return;
  }

  for (const mod of customMods) {
    const row = document.createElement('div');
    row.className = `custom-mod-row${mod.enabled ? '' : ' disabled'}`;

    let icon;
    if (mod.iconUrl) {
      icon = document.createElement('img');
      icon.src = mod.iconUrl;
      icon.alt = '';
    } else {
      icon = document.createElement('div');
      icon.className = 'mod-browse-icon placeholder';
      icon.textContent = mod.name.slice(0, 1).toUpperCase();
    }

    const source = mod.source || 'modrinth';
    const info = document.createElement('div');
    info.innerHTML = `
      <div class="title">${mod.name}</div>
      <div class="sub">
        <span class="source-badge ${source}">${sourceBadgeLabel(source)}</span>
        ${mod.isDependency ? '<span class="dep-badge">dependency</span>' : ''}
        ${mod.version ? `v${mod.version}` : 'Unknown version'}${mod.installed ? '' : ' • missing file'}
      </div>
    `;

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = mod.enabled;
    toggle.title = 'Enable mod';
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      await window.bloodpact.toggleCustomMod(mod.id, toggle.checked);
      await refreshState(false);
      toggle.disabled = false;
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'modrinth-remove-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      removeBtn.disabled = true;
      modBrowseStatusEl.className = 'browse-status';
      modBrowseStatusEl.textContent = `Removing ${mod.name}…`;
      await window.bloodpact.removeCustomMod(mod.id);
      modBrowseStatusEl.textContent = `Removed ${mod.name}`;
      await refreshState(false);
    });

    row.appendChild(icon);
    row.appendChild(info);
    row.appendChild(toggle);
    row.appendChild(removeBtn);
    customModListEl.appendChild(row);
  }
}

async function runModSearch(query) {
  const meta = SOURCE_META[activeModSource] || SOURCE_META.modrinth;
  const trimmed = (query ?? '').trim();
  let searchText = trimmed;
  if (!searchText) {
    searchText = activeModSource === 'free' ? '' : (meta.defaultQuery || 'optimization');
  }

  modBrowseStatusEl.className = 'browse-status';
  modBrowseStatusEl.textContent = activeModSource === 'free' && !trimmed
    ? 'Loading free mod picks…'
    : `Searching ${sourceBadgeLabel(activeModSource)} for "${searchText}"…`;
  modBrowseResultsEl.innerHTML = '';

  const submitBtn = modSearchForm.querySelector('.search-btn');
  submitBtn.disabled = true;

    try {
      const result = await window.bloodpact.searchMods(activeModSource, searchText);
      if (result.notice) {
        modBrowseStatusEl.textContent = result.notice;
      } else if (activeModSource === 'free' && !trimmed) {
        modBrowseStatusEl.textContent = `${result.total} free picks for ${result.loader} ${result.gameVersion}`;
      } else {
        modBrowseStatusEl.textContent = `${result.total} ${result.loader} ${result.gameVersion} results for "${searchText}"`;
      }
      renderBrowseResults(result.hits, result.fallbackSource || activeModSource);
    } catch (error) {
      modBrowseStatusEl.className = 'browse-status error';
      if (error.message?.includes('CurseForge API key')) {
        modBrowseStatusEl.innerHTML = `${error.message} <button type="button" class="inline-link-btn" id="open-settings-for-cf">Open Settings</button>`;
        document.getElementById('open-settings-for-cf')?.addEventListener('click', () => {
          document.querySelector('.meteor-tab[data-tab="settings"]')?.click();
          curseForgeApiKeyInput?.focus();
        });
      } else {
        modBrowseStatusEl.textContent = `Search failed: ${error.message}`;
      }
    } finally {
    submitBtn.disabled = false;
  }
}

function renderLocalMods(localMods) {
  localModListEl.innerHTML = '';
  if (!localMods.length) {
    const li = document.createElement('li');
    li.textContent = 'No mod jars found yet — BloodPact will download them on Play.';
    localModListEl.appendChild(li);
    return;
  }

  for (const mod of localMods) {
    const li = document.createElement('li');
    li.textContent = `${mod.filename} (${Math.round(mod.size / 1024)} KB)`;
    localModListEl.appendChild(li);
  }
}

function renderModCatalog(catalog) {
  modCategoriesEl.innerHTML = '';
  const categories = catalog.modpack.categories || {};
  const grouped = {};

  for (const mod of catalog.mods) {
    grouped[mod.category] = grouped[mod.category] || [];
    grouped[mod.category].push(mod);
  }

  for (const [categoryId, mods] of Object.entries(grouped)) {
    const block = document.createElement('section');
    block.className = 'category-block';

    const title = document.createElement('h3');
    title.textContent = categories[categoryId] || categoryId;
    block.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'mod-grid';

    for (const mod of mods) {
      const card = document.createElement('div');
      card.className = `mod-card${mod.required || mod.locked ? ' required' : ''}`;

      const info = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = mod.name;
      const source = document.createElement('div');
      source.className = 'source';
      if (mod.essential || mod.id === 'essential') {
        source.textContent = 'Always on — invite friends & share worlds';
      } else if (mod.source === 'local') {
        source.textContent = 'Built-in BloodPact client';
      } else if (mod.locked) {
        source.textContent = 'Required for this pack';
      } else {
        source.textContent = 'Download or reuse from your PC';
      }
      info.appendChild(name);
      info.appendChild(source);

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = mod.enabled;
      toggle.disabled = mod.required || mod.locked;
      toggle.addEventListener('change', async () => {
        await window.bloodpact.toggleMod(mod.id, toggle.checked);
        await refreshState(false);
      });

      card.appendChild(info);
      card.appendChild(toggle);
      grid.appendChild(card);
    }

    block.appendChild(grid);
    modCategoriesEl.appendChild(block);
  }
}

function renderProfileOptions(modpacks, selectedId) {
  launchProfileSelectEl.innerHTML = '';

  for (const pack of modpacks) {
    const launchOption = document.createElement('option');
    launchOption.value = pack.id;
    const liteTag = pack.lowRamProfile ? ' • low RAM' : '';
    launchOption.textContent = `${pack.name} (${pack.minecraftVersion})${liteTag}`;
    launchOption.selected = pack.id === selectedId;
    launchProfileSelectEl.appendChild(launchOption);
  }
}

function renderProfileChrome() {
  const pack = currentState?.profile?.modpack || {};
  const profileName = currentState?.profile?.name || pack.name || 'BloodPact';
  const version = pack.minecraftVersion || '1.21';
  const loader = pack.loader || 'fabric';
  const loaderLabel = loader === 'vanilla'
    ? 'Vanilla'
    : `Fabric ${pack.fabricLoaderVersion || ''}`.trim();

  mcVersionEl.textContent = `Minecraft ${version}`;
  loaderTagEl.textContent = loaderLabel;
  heroEyebrowEl.textContent = `${loaderLabel} • Minecraft ${version}`;
  heroTitleEl.textContent = profileName;
  heroCopyEl.textContent = pack.description || 'Each version pack keeps its own mods folder and Minecraft version.';
  if (headerTagEl) {
    headerTagEl.textContent = `${profileName} • ${version}`;
  }

  heroTagsEl.innerHTML = '';
  const tags = pack.tags?.length ? pack.tags : ['PvP', 'Performance'];
  for (const tag of tags) {
    const span = document.createElement('span');
    span.textContent = tag;
    heroTagsEl.appendChild(span);
  }

  if (modsPanelTitleEl) {
    modsPanelTitleEl.textContent = `${profileName} Modpack`;
  }
  if (modsPanelCopyEl) {
    modsPanelCopyEl.textContent = `Mods for Minecraft ${version}. Toggle optional ones — required mods stay on.`;
  }
}

async function switchProfile(profileId) {
  setStatus('Switching version pack...');
  await window.bloodpact.selectProfile(profileId);
  browseLoaded = false;
  await refreshState(false);
  setStatus(`Selected ${currentState.profile.name}`, 'ok');
}

function renderCrashLog(crash) {
  if (!crashLogSummaryEl || !crashLogPreviewEl || !openCrashLogBtn) {
    return;
  }

  if (!crash) {
    crashLogSummaryEl.textContent = 'No crashes recorded for this profile.';
    crashLogPreviewEl.classList.add('hidden');
    crashLogPreviewEl.textContent = '';
    openCrashLogBtn.disabled = true;
    if (crashAlertEl) {
      crashAlertEl.classList.add('hidden');
    }
    return;
  }

  const when = crash.summary?.time || new Date(crash.mtimeMs).toLocaleString();
  const description = crash.summary?.description || 'Minecraft crashed';
  const exception = crash.summary?.exception ? ` — ${crash.summary.exception}` : '';
  const summaryText = `${when}: ${description}${exception}`;
  crashLogSummaryEl.textContent = summaryText;
  crashLogPreviewEl.textContent = crash.preview || '';
  crashLogPreviewEl.classList.toggle('hidden', !crash.preview);
  openCrashLogBtn.disabled = false;

  if (crashAlertEl && crashAlertTextEl) {
    crashAlertEl.classList.remove('hidden');
    crashAlertTextEl.textContent = summaryText;
  }
}

async function refreshState(showReady = true) {
  currentState = await window.bloodpact.getState();
  usernameInput.value = currentState.defaultUsername || '';
  if (accountUsernameInput) {
    accountUsernameInput.value = currentState.config.accountUsername || currentState.defaultUsername || '';
  }
  if (curseForgeApiKeyInput) {
    curseForgeApiKeyInput.value = currentState.config.curseForgeApiKey || '';
  }
  memorySelect.value = currentState.profile?.memory || '4G';
  const launchSettings = currentState.launchSettings || {};
  if (launchSettings.lowRamSystem && !memorySelect.querySelector(`option[value="${memorySelect.value}"]`)) {
    memorySelect.value = '2G';
  }
  minecraftPathEl.textContent = currentState.instanceModsDir || currentState.minecraftDir;

  if (javaPathEl) {
    const javaLabel = launchSettings.javaCompatible
      ? `Java ${launchSettings.javaMajor} — ${launchSettings.javaPath}`
      : `Needs Java ${launchSettings.requiredJavaMajor}+ — found ${launchSettings.javaPath || 'none'}`;
    javaPathEl.textContent = javaLabel;
  }
  if (memoryNoteEl) {
    const safeLabel = launchSettings.maxSafeMemoryLabel || '4 GB';
    const selectedLabel = launchSettings.selectedMemoryLabel || memorySelect.value;
    const liteId = launchSettings.suggestLiteProfileId;
    const hasLitePack = (currentState.modpacks || []).some((pack) => pack.id === liteId);
    const onLite = currentState.profile?.modpackId === liteId || currentState.profile?.id === liteId;
    let note = launchSettings.memoryClamped
      ? `Selected ${selectedLabel} is too high for this PC. BloodPact will cap RAM at ${safeLabel}.`
      : `Safe maximum on this PC: about ${safeLabel}. Higher RAM can help modded Minecraft.`;
    if (launchSettings.lowRamSystem && liteId && hasLitePack && !onLite) {
      note += ' For 4 GB PCs, switch the version pack to BloodPact Lite and set RAM to 2 GB.';
    } else if (onLite) {
      note += ' Lite pack uses fewer mods — close Chrome/Discord before Play.';
    }
    memoryNoteEl.textContent = note;
  }
  if (packVersionLabelEl && currentState?.packVersion) {
    packVersionLabelEl.textContent = `Pack v${currentState.packVersion}`;
  }
  renderProfileOptions(currentState.modpacks || [], currentState.profile?.id);
  renderProfileChrome();
  renderModCatalog(currentState.catalog);
  renderLocalMods(currentState.localMods);
  renderCustomMods(currentState.customMods || []);
  renderCrashLog(currentState.latestCrash);
  renderOpSeeds(currentState.opSeeds);

  const customCount = (currentState.customMods || []).filter((mod) => mod.enabled).length;
  const enabledCount = currentState.catalog.mods.filter((mod) => mod.enabled).length;
  setSummary([
    `${enabledCount} pack mods enabled`,
    `${customCount} extra mods added`,
    `${currentState.localMods.length} jars in this profile`
  ]);

  if (showReady) {
    if (currentState.launchBlockedReason) {
      setStatus(currentState.launchBlockedReason, 'error');
    } else {
      setStatus('Ready to launch');
    }
  }
}

launchProfileSelectEl.addEventListener('change', async () => {
  await switchProfile(launchProfileSelectEl.value);
  launchProfileSelectEl.value = currentState.profile.id;
});

modSearchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await runModSearch(modSearchQueryInput.value.trim());
});

sourceTabs.forEach((tab) => {
  tab.addEventListener('click', async () => {
    const source = tab.dataset.source;
    if (!source || source === activeModSource) {
      return;
    }
    setActiveModSource(source);
    browseLoaded = true;
    await runModSearch(modSearchQueryInput.value.trim());
  });
});

playBtn.addEventListener('click', async () => {
  const defaultUsername = currentState?.defaultUsername || 'BloodPactPlayer';
  const username = usernameInput.value.trim() || defaultUsername;
  setStatus('Preparing mods and launching Minecraft...');
  playBtn.disabled = true;

  await window.bloodpact.saveSettings({
    profiles: {
      ...currentState.config.profiles,
      [currentState.config.selectedProfile || 'bloodpact-pvp']: {
        ...(currentState.profile || {}),
        memory: memorySelect.value
      }
    }
  });

  try {
    const result = await window.bloodpact.play(username);
    if (result.ok) {
      let message = 'Minecraft launched with BloodPact.';
      if (result.message) {
        message += ` ${result.message}`;
      }
      if (result.memoryClamped) {
        message += ' RAM was capped to a safe amount for your PC.';
      }
      setStatus(message, 'ok');
    } else {
      setStatus(result.error || 'Launch failed', 'error');
    }
    await refreshState(false);
  } catch (error) {
    setStatus(`Launch failed: ${error.message}`, 'error');
  } finally {
    playBtn.disabled = false;
  }
});

if (openCrashLogBtn) {
  openCrashLogBtn.addEventListener('click', async () => {
    try {
      const result = await window.bloodpact.openCrashLog();
      if (!result.ok) {
        setStatus(result.error || 'Could not open crash report', 'error');
      }
    } catch (error) {
      setStatus(`Could not open crash report: ${error.message}`, 'error');
    }
  });
}

if (crashAlertOpenBtn) {
  crashAlertOpenBtn.addEventListener('click', async () => {
    document.querySelector('.meteor-tab[data-tab="settings"]')?.click();
    try {
      await window.bloodpact.openCrashLog();
    } catch (error) {
      setStatus(`Could not open crash report: ${error.message}`, 'error');
    }
  });
}

if (accountUsernameInput) {
  accountUsernameInput.addEventListener('change', async () => {
    const accountUsername = accountUsernameInput.value.trim();
    if (!accountUsername) {
      return;
    }

    await window.bloodpact.saveSettings({ accountUsername });
    await refreshState(false);
    setStatus('Saved your account username', 'ok');
  });
}

if (curseForgeApiKeyInput) {
  curseForgeApiKeyInput.addEventListener('change', async () => {
    await window.bloodpact.saveSettings({ curseForgeApiKey: curseForgeApiKeyInput.value.trim() });
    await refreshState(false);
    setStatus('Saved CurseForge API key', 'ok');
  });
}

if (installUpdateBtn) {
  installUpdateBtn.addEventListener('click', installCloudUpdate);
}

if (settingsInstallUpdateBtn) {
  settingsInstallUpdateBtn.addEventListener('click', installCloudUpdate);
}

if (checkUpdatesBtn) {
  checkUpdatesBtn.addEventListener('click', async () => {
    checkUpdatesBtn.disabled = true;
    try {
      await runUpdateCheck(true);
    } finally {
      checkUpdatesBtn.disabled = false;
    }
  });
}

if (opSeedSelectEl) {
  opSeedSelectEl.addEventListener('change', async () => {
    const result = await window.bloodpact.selectOpSeed(opSeedSelectEl.value);
    if (!result.ok) {
      setStatus(result.error || 'Could not save seed', 'error');
      return;
    }
    await refreshState(false);
    setStatus(result.active ? `Selected ${result.active.name}` : 'Seed cleared', 'ok');
  });
}

if (customOpSeedInput) {
  customOpSeedInput.addEventListener('change', async () => {
    const result = await window.bloodpact.setCustomOpSeed(customOpSeedInput.value.trim());
    if (!result.ok) {
      setStatus(result.error || 'Invalid custom seed', 'error');
      return;
    }
    await refreshState(false);
    setStatus(result.active ? `Using custom seed ${result.active.seed}` : 'Custom seed cleared', 'ok');
  });
}

if (clearOpSeedBtn) {
  clearOpSeedBtn.addEventListener('click', async () => {
    await window.bloodpact.clearOpSeed();
    await refreshState(false);
    setStatus('Seed selection cleared', 'ok');
  });
}

if (copyOpSeedBtn) {
  copyOpSeedBtn.addEventListener('click', copyActiveSeedToClipboard);
}

async function boot() {
  setupTabs();
  setActiveModSource(activeModSource);
  splashTextEl.textContent = 'Loading BloodPact...';
  try {
    await refreshState(false);
    showApp();
    runUpdateCheck(false).catch(() => {});
  } catch (error) {
    splashTextEl.textContent = `Failed to load: ${error.message}`;
  }
}

boot();
