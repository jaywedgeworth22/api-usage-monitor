// Listens for messages from content scripts and forwards them to the API Usage Monitor
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'SYNC_KEYS') {
    syncKeys(request.provider, request.keys)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    
    return true; // Indicates we will send a response asynchronously
  }
});

async function syncKeys(provider, keys) {
  const result = await chrome.storage.local.get(['apiUrl', 'apiToken']);
  const apiUrl = result.apiUrl;
  const apiToken = result.apiToken;

  if (!apiUrl || !apiToken) {
    throw new Error('Usage Monitor URL or Token not configured.');
  }

  const endpoint = `${apiUrl}/api/ingest/keys`;
  
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiToken}`
    },
    body: JSON.stringify({
      provider: provider,
      keys: keys
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to sync: ${response.status} ${errorText}`);
  }
}
