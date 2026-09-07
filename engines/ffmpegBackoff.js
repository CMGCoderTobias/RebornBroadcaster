function clampInt(n, min, max) {
  const v = Number.parseInt(String(n), 10);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function createFfmpegBackoffController({
  startBitrateKbps,
  minBitrateKbps = 64,
  maxBitrateKbps = 320,
  stepDownKbps = 32,
  speedThreshold = 0.95,
  windowMs = 12000,
  cooldownMs = 45000,
} = {}) {
  let targetBitrate = clampInt(startBitrateKbps, minBitrateKbps, maxBitrateKbps);
  let lowSpeedSince = null;
  let lastBackoffAt = 0;

  function observeStderrLine(line) {
    // Parse: speed=0.98x
    const m = /speed\s*=\s*([0-9]+(?:\.[0-9]+)?)x/i.exec(String(line || ''));
    if (!m) return { action: 'none', targetBitrate };

    const speed = Number.parseFloat(m[1]);
    if (!Number.isFinite(speed)) return { action: 'none', targetBitrate };

    const now = Date.now();

    if (speed >= speedThreshold) {
      lowSpeedSince = null;
      return { action: 'none', targetBitrate, speed };
    }

    if (!lowSpeedSince) lowSpeedSince = now;

    const lowForMs = now - lowSpeedSince;
    const inCooldown = now - lastBackoffAt < cooldownMs;

    if (lowForMs >= windowMs && !inCooldown && targetBitrate > minBitrateKbps) {
      const next = Math.max(minBitrateKbps, targetBitrate - stepDownKbps);
      if (next !== targetBitrate) {
        targetBitrate = next;
        lastBackoffAt = now;
        lowSpeedSince = null;
        return { action: 'backoff', targetBitrate, speed };
      }
    }

    return { action: 'none', targetBitrate, speed };
  }

  function getTargetBitrate() {
    return targetBitrate;
  }

  return { observeStderrLine, getTargetBitrate };
}

module.exports = { createFfmpegBackoffController };