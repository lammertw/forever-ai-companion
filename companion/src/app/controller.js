// The app's brain: owns the config, the watcher and the activity log, and
// implements every action the window can trigger.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EFFORTS, PRESETS, env, presetEffort, envVar, loadConfig, readUserConfig, saveConfig, wowPaths } from '../config.js';
import { startBeacon } from '../beacon.js';
import { findWowDirs, isWowRunning, isWowRunningAsync, normalizeWowDir } from '../detect.js';
import {
  bundledAddonVersion, ensureAddon, finishLegacyMigration, hasLegacyAddon, install, installedAddonVersion, isAddonInstalled,
  uninstall as uninstallAddon,
} from '../install.js';
import { knowledgeReadme, sampleContext } from '../assets.js';
import { buildMessages, buildSystemParts, cleanAnswer, loadKnowledge, plainAnswer } from '../prompt.js';
import { ask, canFetchData, canSearch } from '../providers.js';
import { startWatcher } from '../watcher.js';
import { authStatus, findClaudeCode, openInstall, openLogin } from '../claude-code.js';
import {
  codexAuthStatus, codexInstallState, codexSearchState, codexVersion, findCodex, installCodex, openCodexLogin, searchCodex,
} from '../codex.js';
import { ttsEngineSource } from '../assets.js';
import {
  ENGINE_DLL, compileEngine, installVoiceMachineWide, isLegacyEngineRegistered, isLegacyVoiceVisible, isVoiceVisible,
  machineEngineState, uninstallVoiceMachineWide,
} from '../tts-voice.js';
import { removeLegacyInstallDir } from '../migrate.js';
import { disableMacVoice, enableMacVoice, macVoiceStatus, removeMacVoice, requestScreenAccess } from '../mac-voice.js';
import { installMacUpdate } from '../mac-update.js';
import { removeKeychainKey } from '../secrets.js';
import * as sys from './system.js';
import { err, getAppLang, setAppLang, t } from '../i18n.js';
import { TOPICS_FILE, currentGuide, guideFreshness, startGuideUpdates, topicsUrl } from '../guide.js';
import { createUpdater } from '../updater.js';

export const VERSION = '1.12.1';

// Where the silent voice's DLL lives (it is loaded by the game while in use).
// Only programs running as the player load this copy (per-user registration);
// elevated ones load an admin-only copy under Program Files (see tts-voice.js).
const voiceDll = () => path.join(sys.isPackaged() ? sys.installDir() : env.dataDir, ENGINE_DLL);
const engineSourceHash = () => crypto.createHash('sha256').update(ttsEngineSource()).digest('hex');
// How often to check whether the game was closed, while the addon under the
// project's previous name is still in the AddOns folder.
const LEGACY_ADDON_CHECK_MS = 10000;
// How often to check that the chosen subscription AI is still signed in.
const LOGIN_CHECK_MS = 5 * 60 * 1000;

// onUpdateAvailable(version): a newer release was found (tray notice).
export function createController({ log = () => {}, onUpdateAvailable = () => {}, onQuit = () => process.exit(0) } = {}) {
  let cfg = loadConfig();
  setAppLang(cfg.language && cfg.language !== 'auto' ? cfg.language : null);
  let watcher = null;
  let watcherError = null;
  let beacon = null;     // app status for the game (see beacon.js)
  let loginTimer = null;
  let autostart; // cached: reading it spawns reg.exe
  let trayReady = false; // icon next to the Windows clock is running
  const events = [];
  const bundledVersion = bundledAddonVersion();

  const knowledgeDir = () => path.join(env.dataDir, 'knowledge');
  const ensureKnowledgeDir = () => {
    const dir = knowledgeDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'README.md'), knowledgeReadme());
    }
  };
  ensureKnowledgeDir();

  // Updates from GitHub releases: only the installed app (or a test server).
  const updateApi = envVar('UPDATE_API');
  const updater = sys.isPackaged() || updateApi ? createUpdater({
    currentVersion: VERSION,
    dir: path.join(env.dataDir, 'updates'),
    log,
    onAvailable: onUpdateAvailable,
    ...(updateApi ? { apiUrl: updateApi, allowUrl: (u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u) } : {}),
  }) : null;

  // WoW Forever guide: the one inside the app or a newer downloaded one.
  const guideDir = path.join(env.dataDir, 'guide');
  let guide = currentGuide(guideDir);
  const guideUpdates = startGuideUpdates({
    url: cfg.guideUrl, dir: guideDir, log, onUpdate: () => { guide = currentGuide(guideDir); },
  });
  // Detailed topics (dungeons, zones, classes...): each question gets its sections.
  let topics = currentGuide(guideDir, TOPICS_FILE);
  const topicsUpdates = startGuideUpdates({
    url: topicsUrl(cfg.guideUrl), dir: guideDir, file: TOPICS_FILE, log, onUpdate: () => { topics = currentGuide(guideDir, TOPICS_FILE); },
  });
  const guides = {
    current: () => guide,
    topics: () => topics,
    onPatch: () => { guideUpdates.check('patch'); topicsUpdates.check('patch'); },
  };

  const wowDirValid = () => Boolean(cfg.wowDir && fs.existsSync(cfg.wowDir));
  const addonOk = () => wowDirValid() && isAddonInstalled(cfg.wowDir, cfg);

  function addEvent(e) {
    if (e.type === 'problem') {
      events.push({ id: `p${Date.now()}`, who: 'Forever AI Companion', question: t('unreadableQuestion'), ok: false, answer: e.message, pending: false, time: new Date().toISOString() });
      while (events.length > 20) events.shift();
      return;
    }
    if (e.type === 'answer') {
      const q = events.find((x) => x.id === e.id);
      if (q) Object.assign(q, { ok: e.ok, answer: e.answer, pending: false, tokens: e.tokens || null });
      return;
    }
    events.push({ ...e, pending: true, time: new Date().toISOString() });
    while (events.length > 20) events.shift();
  }

  // The addon under the project's previous name stays while the game runs (it
  // may have it loaded); once the game is closed it is removed and the saved
  // chats are copied again if the game saved them since.
  let legacyTimer = null;
  let legacyChecking = false;
  function watchLegacyAddon() {
    if (legacyTimer || !wowDirValid() || !hasLegacyAddon(cfg.wowDir)) return;
    legacyTimer = setInterval(async () => {
      if (legacyChecking) return;
      legacyChecking = true;
      try {
        const dir = cfg.wowDir;
        if (!dir || !fs.existsSync(dir) || !hasLegacyAddon(dir)) { clearInterval(legacyTimer); legacyTimer = null; return; }
        const running = await isWowRunningAsync();
        if (finishLegacyMigration(dir, { wowRunning: running, log })) { clearInterval(legacyTimer); legacyTimer = null; }
      } catch (e) {
        log(`Addon with the previous name: ${e.message}`);
      } finally {
        legacyChecking = false;
      }
    }, LEGACY_ADDON_CHECK_MS);
    legacyTimer.unref?.();
  }

  function restartWatcher() {
    if (watcher) watcher.stop();
    watcher = null;
    watcherError = null;
    if (!wowDirValid()) { watcherError = t('needGameFolder'); return; }
    try {
      // Keep the in-game addon up to date with this app's version; coming
      // from before the rename, install it under its current name.
      ensureAddon(cfg, { wowDir: cfg.wowDir, log });
    } catch (e) {
      log(`Could not update the addon: ${e.message}`);
    }
    watchLegacyAddon();
    if (!addonOk()) { watcherError = t('needAddon'); return; }
    try {
      watcher = startWatcher({ cfg, wowDir: cfg.wowDir, log, onEvent: addEvent, guides });
      log(`Waiting for questions (${cfg.provider}) in ${cfg.wowDir}`);
    } catch (e) {
      watcherError = e.message;
      log(`Could not start: ${e.message}`);
    }
  }

  function save(patch) {
    cfg = saveConfig(patch);
    restartWatcher();
    checkLogin();
  }

  // Whether the chosen subscription AI (Claude Code, Codex) is installed and
  // signed in: true / false, or null when unknown or not needed. Checked now
  // and then (it runs the AI's own program), and whenever settings change.
  let aiSignedIn = null;
  let loginCheck = null;
  function checkLogin() {
    const provider = cfg.provider;
    if (provider !== 'claude-code' && provider !== 'codex') {
      aiSignedIn = null;
      beacon?.refresh();
      return Promise.resolve();
    }
    // Not installed: false. The status check itself failing: unknown.
    const run = (async () => {
      const found = provider === 'claude-code' ? findClaudeCode(cfg.claudeCode.bin) : findCodex(cfg.codex.bin);
      if (!found) return false;
      const s = provider === 'claude-code' ? await authStatus(found.path) : await codexAuthStatus(found.path);
      return s.error ? null : s.loggedIn;
    })();
    loginCheck = run;
    return run
      .then((ok) => { if (loginCheck === run) aiSignedIn = typeof ok === 'boolean' ? ok : null; })
      .catch(() => { if (loginCheck === run) aiSignedIn = null; })
      .finally(() => beacon?.refresh());
  }

  // The window checked the sign-in itself (setup and dashboard): use that too,
  // so signing in shows up in the game right away.
  function noteSignIn(provider, s) {
    if (cfg.provider !== provider || s.error) return;
    const ok = Boolean(s.installed && s.loggedIn);
    if (ok !== aiSignedIn) { aiSignedIn = ok; beacon?.refresh(); }
  }

  // Why questions from the game can't be answered right now (null: ready).
  // Shown in the addon's chat header (beacon.js).
  function notReadyReason() {
    if (watcherError) return 'problem';
    // Without a choice the app falls back to "echo" (a test that repeats the
    // question): that is no AI. A provider set by hand in config.json counts.
    const preset = cfg.preset || null;
    let configured = Boolean(preset) || Boolean(envVar('PROVIDER'));
    if (!configured) {
      try { configured = Boolean(readUserConfig().provider); } catch { configured = false; }
    }
    if (!configured) return 'need-ai';
    if (preset && PRESETS[preset]?.needsKey && !cfg.keys?.[preset]) return 'need-ai';
    if (aiSignedIn === false) return 'need-login';
    return null;
  }

  // (Re)compiles the silent voice when its source changed (app updates).
  // Registration stays the same, so no administrator prompt is needed.
  async function refreshVoiceDll(force = false) {
    const dll = voiceDll();
    const source = ttsEngineSource();
    const hash = engineSourceHash();
    const hashFile = `${dll}.source-sha256`;
    const current = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf8') : null;
    if (!force && current === hash && fs.existsSync(dll)) return dll;
    const src = path.join(env.dataDir, ENGINE_DLL.replace(/\.dll$/i, '.cs'));
    fs.mkdirSync(env.dataDir, { recursive: true });
    fs.writeFileSync(src, source);
    await compileEngine(src, dll);
    fs.writeFileSync(hashFile, hash);
    log('Invisible voice updated.');
    return dll;
  }
  if (sys.isWindows) {
    Promise.all([isVoiceVisible(), isLegacyVoiceVisible()])
      .then(([active, legacy]) => (active || legacy ? refreshVoiceDll() : null))
      .catch((e) => log(`Could not update the invisible voice: ${e.message}`));
  }
  // macOS: the silent voice ships inside the app and is on unless the player
  // turned it off. Registering it again on every start keeps it pointing at
  // this copy of the app (after updates or moving the app).
  if (sys.isMac && cfg.macVoice !== false && !envVar('NO_MAC_VOICE')) {
    enableMacVoice({ log }).catch((e) => log(`Could not enable the invisible voice: ${e.message}`));
  }

  // First run: find the game on our own.
  if (!wowDirValid()) {
    const [found] = findWowDirs();
    if (found) {
      cfg = saveConfig({ wowDir: found });
      log(`WoW Forever found in ${found}`);
    }
  }
  restartWatcher();

  // Tells the game whether this app is open and ready (the addon's chat header).
  beacon = startBeacon({
    paths: () => (addonOk() ? wowPaths(cfg.wowDir) : null),
    reason: notReadyReason,
    log,
  });
  checkLogin();
  loginTimer = setInterval(checkLogin, LOGIN_CHECK_MS);
  loginTimer.unref?.();

  const mask =(k) => (k ? `••••${String(k).slice(-4)}` : null);

  return {
    async status() {
      const preset = cfg.preset || (cfg.provider === 'echo' ? 'echo' : null);
      return {
        version: VERSION,
        platform: process.platform,
        lang: getAppLang(),
        packaged: sys.isPackaged(),
        wow: {
          dir: cfg.wowDir,
          valid: wowDirValid(),
          addonInstalled: addonOk(),
          addonVersion: wowDirValid() ? installedAddonVersion(cfg.wowDir) : null,
          bundledVersion,
        },
        ai: {
          preset,
          provider: cfg.provider,
          keys: Object.fromEntries(Object.keys(PRESETS).map((p) => [p, mask(cfg.keys?.[p])])),
          models: cfg.models || {},
          defaults: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v.model || null])),
          // Reasoning chosen for each AI that has it, and the recommended one.
          efforts: Object.fromEntries(Object.keys(PRESETS).filter((k) => PRESETS[k].effort).map((k) => [k, presetEffort(cfg, k)])),
          effortDefaults: Object.fromEntries(Object.entries(PRESETS).filter(([, v]) => v.effort).map(([k, v]) => [k, v.effort])),
          webSearch: cfg.webSearch !== false,
          // Why the chosen AI can't answer yet: "need-ai" (no AI or no key),
          // "need-login" (Claude Code / Codex signed out), or null.
          issue: ['need-ai', 'need-login'].includes(notReadyReason()) ? notReadyReason() : null,
        },
        running: Boolean(watcher),
        problem: watcherError,
        events: [...events].reverse(),
        autostart: autostart === undefined ? (autostart = await sys.getAutostart()) : autostart,
        closeAction: cfg.closeAction || 'ask',
        tray: trayReady,
        guide: guide ? {
          date: guide.meta.date,
          source: guide.source,
          age: guideFreshness(guide).age,
          stale: guideFreshness(guide).stale,
          autoUpdate: Boolean(cfg.guideUrl),
        } : null,
        update: updater ? updater.state() : null,
      };
    },

    async checkUpdate() {
      if (!updater) return { status: 'unsupported' };
      return updater.check();
    },

    // Downloads and verifies the new version, then runs it: it closes this
    // app, replaces it and starts again in the background (the window reloads).
    async installUpdate() {
      if (!updater) throw err('updateUnsupported');
      const exe = await updater.download();
      log(`Installing update from ${exe}`);
      if (sys.isMac) {
        // The new app replaces this one once it has quit, and starts again.
        await installMacUpdate(exe, { log });
        setTimeout(() => onQuit(), 300);
        return { restarting: true };
      }
      sys.relaunch(exe, ['--background']);
      return { restarting: true };
    },

    async checkGuide() {
      const [updated, topicsUpdated] = await Promise.all([guideUpdates.check('manual'), topicsUpdates.check('manual')]);
      return { updated: updated || topicsUpdated, date: guide?.meta.date || null };
    },

    setTrayReady(v) { trayReady = Boolean(v); },
    setWebSearch({ enabled }) {
      save({ webSearch: Boolean(enabled) });
      return { webSearch: Boolean(enabled) };
    },
    closeAction() { return cfg.closeAction || 'ask'; },
    setCloseAction({ action }) {
      if (!['ask', 'tray', 'quit'].includes(action)) throw err('unknownOption');
      save({ closeAction: action });
      return { closeAction: action };
    },

    detectWow() {
      const dirs = findWowDirs();
      if (dirs[0]) save({ wowDir: dirs[0] });
      return { found: dirs };
    },

    async pickWow() {
      const chosen = await sys.pickFolder();
      if (!chosen) return { cancelled: true };
      const dir = normalizeWowDir(chosen);
      if (!dir) throw err('notForeverFolder');
      save({ wowDir: dir });
      return { dir };
    },

    installAddon() {
      if (!wowDirValid()) throw err('needGameFolder');
      install(cfg, { wowDir: cfg.wowDir, log });
      restartWatcher();
      return { wowRunning: isWowRunning() };
    },

    setAI({ preset, apiKey, model, effort }) {
      if (!PRESETS[preset]) throw err('unknownAI');
      const patch = { preset };
      if (typeof apiKey === 'string' && apiKey.trim()) patch.keys = { [preset]: apiKey.trim() };
      if (typeof model === 'string') patch.models = { [preset]: model.trim() || null };
      if (PRESETS[preset].effort && EFFORTS.includes(effort)) patch.efforts = { [preset]: effort };
      if (PRESETS[preset].needsKey && !patch.keys && !cfg.keys?.[preset]) {
        throw err('pasteKey');
      }
      save(patch);
      return {};
    },

    async testAI() {
      const req = { id: 'test', question: t('testQuestion'), context: sampleContext(), history: [] };
      const started = Date.now();
      const system = buildSystemParts(loadKnowledge(), 'fizzi', { canSearch: canSearch(cfg), dataTool: canFetchData(cfg), client: req.context?.client, ...(guide ? { guide } : {}) });
      const { text, model } = await ask(cfg, system, buildMessages(req, { select: cfg.contextSelect !== false }), req);
      return { text: plainAnswer(cleanAnswer(text)), model, seconds: ((Date.now() - started) / 1000).toFixed(1) };
    },

    async voiceStatus() {
      if (sys.isMac) return macVoiceStatus();
      if (!sys.isWindows) return { supported: false };
      const active = await isVoiceVisible();
      // Set up by a version from before the rename (the voice's previous name,
      // or its engine still the previous name's DLL): it keeps working, but the
      // window offers to update it (one administrator prompt).
      const legacyName = !active && await isLegacyVoiceVisible();
      const legacyEngine = (active || legacyName) && await isLegacyEngineRegistered();
      // Registered machine-wide from the user's own folder (installs before
      // the protected copy), or from an older engine: one prompt updates it.
      const machine = active && !legacyEngine ? await machineEngineState(engineSourceHash()).catch(() => 'ok') : 'ok';
      const unprotected = machine === 'outside' || machine === 'stale';
      const legacy = legacyName || legacyEngine || unprotected;
      const legacyReason = legacyName || legacyEngine ? 'name' : unprotected ? 'protect' : null;
      return { supported: true, active: active || legacyName, legacy, legacyReason, dll: fs.existsSync(voiceDll()) };
    },

    // Compiles the silent voice and registers it (one administrator prompt).
    async installVoice() {
      if (sys.isMac) {
        if (cfg.macVoice === false) save({ macVoice: true });
        const active = await enableMacVoice({ log });
        return { active, wowRunning: isWowRunning() };
      }
      const dll = await refreshVoiceDll(true);
      await installVoiceMachineWide(dll, env.dataDir, { sourceHash: engineSourceHash() });
      log('Invisible voice enabled.');
      // The old install folder was kept only for the previous voice's DLL.
      if (sys.isPackaged()) removeLegacyInstallDir(sys.legacyInstallDir());
      return { active: await isVoiceVisible(), wowRunning: isWowRunning() };
    },

    // macOS: the on-screen line needs the Screen Recording permission. Asks for
    // it (the first time) and opens its page in System Settings.
    async openScreenSettings() {
      if (!sys.isMac) return {};
      const screen = await requestScreenAccess();
      if (screen !== 'granted') {
        sys.openUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      }
      return { screen };
    },

    async uninstallVoice() {
      if (sys.isMac) {
        save({ macVoice: false });
        await disableMacVoice({ log });
        // The on-screen line reads the game window: macOS asks for permission.
        const screen = await requestScreenAccess();
        return { active: false, screen };
      }
      await uninstallVoiceMachineWide(env.dataDir);
      log('Invisible voice disabled.');
      return { active: await isVoiceVisible() };
    },

    async claudeStatus() {
      const found = findClaudeCode(cfg.claudeCode.bin);
      const out = found
        ? { installed: true, source: found.source, ...(await authStatus(found.path)) }
        : { installed: false, loggedIn: false };
      noteSignIn('claude-code', out);
      return out;
    },

    claudeInstall() {
      openInstall();
      return {};
    },

    claudeLogin() {
      const found = findClaudeCode(cfg.claudeCode.bin);
      if (!found) throw err('installClaudeFirst');
      openLogin(found.path);
      return {};
    },

    async codexStatus() {
      const install = codexInstallState();
      const search = codexSearchState();
      const found = findCodex(cfg.codex.bin);
      const out = found
        ? { installed: true, source: found.source, install, search, ...(await codexAuthStatus(found.path)) }
        : { installed: false, loggedIn: false, install, search };
      noteSignIn('codex', out);
      return out;
    },

    // Already installed (any way): nothing to do. Otherwise the app downloads
    // the official build in the background; codexStatus reports the progress.
    codexInstall() {
      const found = findCodex(cfg.codex.bin);
      if (found) return { already: true, source: found.source };
      installCodex({ log }).catch(() => { /* reported by codexStatus */ });
      return { started: true };
    },

    // Looks for Codex all over the PC (running programs, then the disks) in the
    // background; codexStatus reports how it goes. What it finds is remembered.
    codexSearch() {
      const found = findCodex(cfg.codex.bin);
      if (found) return { already: true, source: found.source };
      searchCodex({ log }).then((file) => { if (file) save({ codex: { bin: file } }); }).catch(() => {});
      return { started: true };
    },

    // The player points at a codex.exe Codex installed some other way.
    async codexPick() {
      const file = await sys.pickFile({ title: t(sys.isMac ? 'pickCodexMac' : 'pickCodex'), filter: 'Codex (codex*.exe;codex.cmd)|codex*.exe;codex.cmd' });
      if (!file) return { cancelled: true };
      if (!(await codexVersion(file))) throw err(sys.isMac ? 'codexPickInvalidMac' : 'codexPickInvalid');
      save({ codex: { bin: file } });
      return { path: file };
    },

    codexLogin() {
      const found = findCodex(cfg.codex.bin);
      if (!found) throw err('installCodexFirst');
      openCodexLogin(found.path);
      return {};
    },

    async setAutostart({ enabled }) {
      autostart = await sys.setAutostart(Boolean(enabled));
      return { autostart };
    },

    openKnowledge() {
      ensureKnowledgeDir();
      sys.openFolder(knowledgeDir());
      return {};
    },

    stop() {
      beacon.stop();
      clearInterval(loginTimer);
      guideUpdates.stop();
      topicsUpdates.stop();
      updater?.stop();
      if (legacyTimer) clearInterval(legacyTimer);
      legacyTimer = null;
      if (watcher) watcher.stop();
      watcher = null;
    },

    // Removes everything this app created. The caller then exits.
    async uninstall() {
      this.stop();
      if (wowDirValid()) uninstallAddon(cfg, cfg.wowDir);
      if (sys.isWindows) await uninstallVoiceMachineWide(env.dataDir).catch((e) => log(e.message));
      if (sys.isMac) {
        await removeMacVoice().catch((e) => log(e.message));
        if (sys.isPackaged()) removeKeychainKey();
      }
      if (sys.isPackaged()) {
        await sys.setAutostart(false).catch(() => {});
        await sys.removeShortcuts().catch(() => {});
      }
      fs.rmSync(env.dataDir, { recursive: true, force: true });
      if (sys.isPackaged()) {
        // Leftovers of the project's previous name, if any.
        removeLegacyInstallDir(sys.legacyInstallDir());
        try { fs.rmSync(sys.legacyAppDataDir(), { recursive: true, force: true }); } catch { /* in use */ }
        sys.scheduleSelfDelete(sys.installDir());
      }
      return {};
    },
  };
}
