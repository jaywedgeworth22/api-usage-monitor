document.addEventListener('DOMContentLoaded', () => {
  const apiUrlInput = document.getElementById('apiUrl');
  const apiTokenInput = document.getElementById('apiToken');
  const saveBtn = document.getElementById('saveBtn');
  const statusDiv = document.getElementById('status');

  // Load existing configuration
  chrome.storage.local.get(['apiUrl', 'apiToken'], (result) => {
    if (result.apiUrl) apiUrlInput.value = result.apiUrl;
    if (result.apiToken) apiTokenInput.value = result.apiToken;
  });

  // Save configuration
  saveBtn.addEventListener('click', () => {
    const apiUrl = apiUrlInput.value.trim().replace(/\/$/, ''); // Remove trailing slash
    const apiToken = apiTokenInput.value.trim();

    chrome.storage.local.set({ apiUrl, apiToken }, () => {
      statusDiv.style.display = 'block';
      setTimeout(() => {
        statusDiv.style.display = 'none';
      }, 2000);
    });
  });
});
