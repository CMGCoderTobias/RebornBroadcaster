window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('minimizeBtn')?.addEventListener('click', () => window.api.minimize());
  document.getElementById('closeBtn')?.addEventListener('click', () => window.api.close());

  try {
    const info = await window.electron.getAppInfo();
    const el = document.getElementById('appInfoLine');
    if (el) el.textContent = `${info.productName} v${info.version}`;
  } catch {
    const el = document.getElementById('appInfoLine');
    if (el) el.textContent = 'RebornBroadcaster';
  }

  try {
    const notices = await window.electron.getThirdPartyNotices();
    const box = document.getElementById('noticesBox');
    if (box) box.textContent = notices || 'No notices file found.';
  } catch (err) {
    const box = document.getElementById('noticesBox');
    if (box) box.textContent = `Failed to load notices: ${err?.message || err}`;
  }
});

