const { spawn } = require('child_process');
const path = require('path');

const { createFfmpegBackoffController } = require('./ffmpegBackoff');

function normalizeMountpoint(mountpoint) {
  const raw = String(mountpoint ?? '').trim();
  const cleaned = raw.replace(/^\/+/, '').replace(/\s+/g, '');
  return cleaned ? `/${cleaned}` : '';
}

function toInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const parsed = parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function buildIcecastUrl(settings) {
  const mount = normalizeMountpoint(settings.mountpoint);
  const icecastPort = toInt(settings.icecastPort);

  const urlOptions = new URLSearchParams();
  if (settings.streamName) urlOptions.set('ice_name', String(settings.streamName));
  if (settings.streamGenre) urlOptions.set('ice_genre', String(settings.streamGenre));
  if (settings.streamDescription) urlOptions.set('ice_description', String(settings.streamDescription));
  if (settings.streamUrl) urlOptions.set('ice_url', String(settings.streamUrl));
  urlOptions.set('ice_public', String(settings.streamPublic ?? '0'));

  return `icecast://${settings.username}:${settings.sourcepassword}@${settings.icecastHost}:${icecastPort}${mount}${urlOptions.toString() ? `?${urlOptions}` : ''}`;
}

function getEncodingArgs(settings, bitrateKbps) {
  const bitrate = toInt(bitrateKbps);
  switch (String(settings.encodingType || 'mp3')) {
    case 'mp3':
      return ['-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-content_type', 'audio/mpeg', '-f', 'mp3'];
    case 'aac':
      return ['-c:a', 'aac', '-b:a', `${bitrate}k`, '-content_type', 'audio/aac', '-f', 'adts'];
    case 'flac':
      return ['-c:a', 'flac', '-content_type', 'audio/flac', '-f', 'flac'];
    case 'opus':
      return ['-c:a', 'libopus', '-b:a', `${bitrate}k`, '-content_type', 'audio/ogg', '-f', 'ogg'];
    default:
      throw new Error(`Unsupported encoding type: ${settings.encodingType}`);
  }
}

function startIcecastAudioStream({
  ffmpegPath,
  settings,
  onLog = () => {},
  onStatus = () => {},
  onNeedRestart = () => {},
} = {}) {
  if (!settings) throw new Error('settings required');

  const outputUrl = buildIcecastUrl(settings);

  const backoff = createFfmpegBackoffController({
    startBitrateKbps: settings.bitrate,
  });

  const bitrateNow = backoff.getTargetBitrate();

  const args = [
    '-hide_banner',
    '-loglevel', 'info',
    '-stats',
    '-f', 'dshow',
    '-i', `audio=${settings.audioSourceName}`,
    ...getEncodingArgs(settings, bitrateNow),
    outputUrl,
  ];

  const proc = spawn(ffmpegPath, args, { windowsHide: true });

  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { proc.kill('SIGINT'); } catch (_) {}
  };

  proc.stdout?.on('data', (d) => {
    onLog(String(d));
  });

  proc.stderr?.on('data', (d) => {
    const text = String(d);
    onLog(text);

    for (const line of text.split(/\r?\n/)) {
      const obs = backoff.observeStderrLine(line);
      if (obs.action === 'backoff') {
        onStatus({ type: 'backoff', reason: 'ffmpeg-slow', targetBitrate: obs.targetBitrate, speed: obs.speed });
        // Ask main to restart with lower bitrate. (Do not auto-mutate persisted settings.)
        onNeedRestart({ newBitrate: obs.targetBitrate, reason: 'ffmpeg-slow' });
      }
    }
  });

  proc.on('exit', (code, signal) => {
    onStatus({ type: 'exit', code, signal });
  });

  return { proc, stop, outputUrl, backoff };
}

module.exports = { startIcecastAudioStream, buildIcecastUrl };