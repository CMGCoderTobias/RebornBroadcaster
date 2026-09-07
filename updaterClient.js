const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const APP_ID = 'rebornbroadcaster';
const DEFAULT_TIMEOUT_MS = 120000;
const STAGE_TIMEOUT_MS = 15 * 60 * 1000;

function run(executable, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, timedOut: true, error: `Updater command timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, error: error.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      let data = null;
      try { data = stdout.trim() ? JSON.parse(stdout.trim()) : null; } catch (_) {}
      finish({ ok: code === 0 && data?.ok !== false, code, data, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function agentRoot() {
  if (process.env.REBORN_UPDATE_AGENT_HOME) return path.resolve(process.env.REBORN_UPDATE_AGENT_HOME);
  return path.join(process.env.LOCALAPPDATA || '', 'Reborn Entertainment', 'UpdateAgent');
}

function installedAgentExecutable() {
  try {
    const root = path.resolve(agentRoot());
    const active = JSON.parse(fs.readFileSync(path.join(root, 'agent-active.json'), 'utf8'));
    const executable = path.resolve(active.directory, active.executable);
    const relative = path.relative(root, executable);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(executable)) return '';
    return executable;
  } catch (_) {
    return '';
  }
}

function shortcutCandidates(electronApp) {
  const candidates = [path.join(electronApp.getPath('desktop'), 'RebornBroadcaster.lnk')];
  const startMenu = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const pending = [startMenu];
  while (pending.length) {
    const directory = pending.pop();
    if (!directory || !fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.name.toLowerCase() === 'rebornbroadcaster.lnk') candidates.push(fullPath);
    }
  }
  return [...new Set(candidates)].filter(fs.existsSync);
}

function installStableLauncher(electronApp, updaterRoot, shortcutApi) {
  if (!shortcutApi) throw new Error('Electron shortcut support is unavailable');
  const installRoot = path.dirname(process.execPath);
  const sourceLauncher = path.join(updaterRoot, 'RebornAppLauncher.exe');
  const sourceConfig = path.join(updaterRoot, 'reborn-launch.json');
  const launcher = path.join(installRoot, 'RebornBroadcasterLauncher.exe');
  if (!fs.existsSync(sourceLauncher) || !fs.existsSync(sourceConfig)) {
    throw new Error('The stable app launcher assets are missing');
  }
  fs.copyFileSync(sourceLauncher, launcher);
  fs.copyFileSync(sourceConfig, path.join(installRoot, 'reborn-launch.json'));

  let shortcutsUpdated = 0;
  for (const shortcutPath of shortcutCandidates(electronApp)) {
    const details = shortcutApi.readShortcutLink(shortcutPath);
    const targetName = path.basename(details.target || '').toLowerCase();
    if (targetName !== path.basename(process.execPath).toLowerCase() && targetName !== 'rebornbroadcaster.exe') continue;
    const updated = shortcutApi.writeShortcutLink(shortcutPath, 'replace', {
      ...details,
      target: launcher,
      cwd: installRoot,
      icon: process.execPath,
      iconIndex: 0,
    });
    if (!updated) throw new Error(`Unable to update shortcut ${shortcutPath}`);
    shortcutsUpdated += 1;
  }
  return { launcher, shortcutsUpdated };
}

async function bootstrapAndDoctor(electronApp, testing = false, shortcutApi = null, onStatus = () => {}) {
  const report = (phase, message) => {
    try { onStatus({ phase, message }); } catch (_) {}
  };
  if (!electronApp.isPackaged || process.platform !== 'win32') {
    return { ok: false, skipped: true, error: 'Updater adoption runs only in packaged Windows builds' };
  }
  const updaterRoot = path.join(process.resourcesPath, 'updater');
  const bootstrap = path.join(updaterRoot, 'RebornUpdateBootstrap.exe');
  const bootstrapConfig = path.join(updaterRoot, testing ? 'agent-bootstrap.testing.json' : 'agent-bootstrap.json');
  const appConfig = path.join(updaterRoot, testing ? 'rebornbroadcaster.testing.app.json' : 'rebornbroadcaster.app.json');
  if (![bootstrap, bootstrapConfig, appConfig].every(fs.existsSync)) {
    return { ok: false, error: 'The packaged updater migration assets are incomplete' };
  }

  const installRoot = path.dirname(process.execPath);
  report('bootstrap', 'Installing or updating the shared Reborn Update Agent…');
  const bootstrapResult = await run(bootstrap, [
    '--config', bootstrapConfig,
    '--app-config', appConfig,
    '--install-root', installRoot,
    '--app-version', electronApp.getVersion(),
    '--app-executable', path.basename(process.execPath),
  ]);
  if (!bootstrapResult.ok) return { ok: false, phase: 'bootstrap', ...bootstrapResult };

  report('verify', 'Verifying RebornBroadcaster with the update service…');
  const agent = installedAgentExecutable();
  if (!agent) return { ok: false, phase: 'locate-agent', error: 'The installed update agent could not be located' };
  const doctor = await run(agent, ['doctor', '--app', APP_ID]);
  if (!doctor.ok) return { ok: false, phase: 'doctor', ...doctor };
  try {
    report('launcher', 'Installing the stable RebornBroadcaster launcher…');
    const launcher = installStableLauncher(electronApp, updaterRoot, shortcutApi);
    report('download', 'Downloading and verifying the native RebornBroadcaster update…');
    const stage = await run(agent, ['stage', '--app', APP_ID], STAGE_TIMEOUT_MS);
    if (!stage.ok) {
      return {
        ok: false,
        phase: 'stage',
        bootstrap: bootstrapResult.data,
        doctor: doctor.data,
        launcher,
        error: stage.error || stage.stderr || stage.stdout || 'The native update could not be prepared',
      };
    }
    return {
      ok: true,
      bootstrap: bootstrapResult.data,
      doctor: doctor.data,
      launcher,
      stage: stage.data,
    };
  } catch (error) {
    return { ok: false, phase: 'launcher', error: error.message };
  }
}

async function launchStagedApp() {
  const agent = installedAgentExecutable();
  if (!agent) return { ok: false, error: 'The installed update agent could not be located' };
  const launched = await run(agent, ['launch', '--app', APP_ID]);
  if (!launched.ok) {
    return { ok: false, error: launched.error || launched.stderr || launched.stdout || 'The native app could not be launched' };
  }
  return { ok: true, ...(launched.data || {}) };
}

function reportHealthFromEnvironment(expectedVersion) {
  const appId = process.env.REBORN_APP_ID;
  const version = process.env.REBORN_APP_VERSION;
  const requestedAgent = process.env.REBORN_UPDATE_AGENT_EXE;
  if (appId !== APP_ID || version !== expectedVersion || !requestedAgent) return;

  const root = path.resolve(agentRoot());
  const executable = path.resolve(requestedAgent);
  const relative = path.relative(root, executable);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(executable)) {
    console.error('[updater] refusing health receipt through an untrusted agent path');
    return;
  }
  const child = spawn(executable, ['health', '--app', APP_ID, '--version', expectedVersion], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
}

module.exports = { bootstrapAndDoctor, launchStagedApp, reportHealthFromEnvironment };
