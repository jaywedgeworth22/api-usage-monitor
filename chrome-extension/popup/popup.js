/* global chrome */
// Usage Monitor launcher popup.
// Stores only a non-secret dashboard URL and opens it in a new tab.
// It never reads cookies, site storage, page content, or any credential,
// and it never transmits data to any endpoint.

document.addEventListener('DOMContentLoaded', () => {
  const urlInput = document.getElementById('dashboardUrl');
  const openBtn = document.getElementById('openBtn');
  const saveBtn = document.getElementById('saveBtn');
  const statusDiv = document.getElementById('status');

  function setStatus(message) {
    statusDiv.textContent = message;
    statusDiv.style.display = 'block';
    setTimeout(() => {
      statusDiv.style.display = 'none';
    }, 2000);
  }

  // Accept only http(s) origins; reject javascript:/data:/file: and garbage.
  function normalizeUrl(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed) return '';
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return (parsed.origin + parsed.pathname).replace(/\/+$/, '');
    } catch {
      return '';
    }
  }

  chrome.storage.local.get(['dashboardUrl'], (result) => {
    if (result.dashboardUrl) urlInput.value = result.dashboardUrl;
  });

  saveBtn.addEventListener('click', () => {
    const url = normalizeUrl(urlInput.value);
    if (!url) {
      setStatus('Enter a valid http(s) URL');
      return;
    }
    urlInput.value = url;
    chrome.storage.local.set({ dashboardUrl: url }, () => setStatus('Saved'));
  });

  openBtn.addEventListener('click', () => {
    const url = normalizeUrl(urlInput.value);
    if (!url) {
      setStatus('Enter a valid http(s) URL');
      return;
    }
    chrome.storage.local.set({ dashboardUrl: url }, () => {
      chrome.tabs.create({ url });
      window.close();
    });
  });
});
