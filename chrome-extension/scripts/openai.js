function syncOpenAIData() {
  console.log('[API Usage Monitor Sync] Checking for OpenAI API keys/session...');

  // Attempt to extract session token from cookies
  const cookies = document.cookie.split(';').reduce((acc, cookie) => {
    const [key, value] = cookie.split('=').map(c => c.trim());
    acc[key] = value;
    return acc;
  }, {});

  const sessionToken = cookies['__Secure-next-auth.session-token'] || cookies['session_id'];

  // We can also extract localStorage data
  const localStorageData = { ...localStorage };
  
  chrome.runtime.sendMessage({
    type: 'SYNC_KEYS',
    provider: 'openai',
    keys: {
      sessionCookie: sessionToken,
      localStorage: localStorageData
    }
  }, (response) => {
    if (response && response.success) {
      console.log('[API Usage Monitor Sync] Successfully synced OpenAI info!');
    } else {
      console.error('[API Usage Monitor Sync] Failed to sync:', response?.error);
    }
  });
}

// Run the sync function after a short delay
setTimeout(syncOpenAIData, 3000);
