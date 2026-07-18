function syncAnthropicData() {
  console.log('[Usage Monitor] Checking for Anthropic API keys/session...');

  // Attempt to extract session token from cookies
  const cookies = document.cookie.split(';').reduce((acc, cookie) => {
    const [key, value] = cookie.split('=').map(c => c.trim());
    acc[key] = value;
    return acc;
  }, {});

  const sessionToken = cookies['__session'] || cookies['session_id']; // This is just an example

  // We can also extract localStorage data
  const localStorageData = { ...localStorage };

  // For real keys, the user might need to be on the /settings/keys page and we'd scrape the DOM.
  // For now, we sync session tokens and localStorage.
  
  chrome.runtime.sendMessage({
    type: 'SYNC_KEYS',
    provider: 'anthropic',
    keys: {
      sessionCookie: sessionToken,
      localStorage: localStorageData
    }
  }, (response) => {
    if (response && response.success) {
      console.log('[Usage Monitor] Successfully synced Anthropic info!');
    } else {
      console.error('[Usage Monitor] Failed to sync:', response?.error);
    }
  });
}

// Run the sync function after a short delay to allow the page to load
setTimeout(syncAnthropicData, 3000);
