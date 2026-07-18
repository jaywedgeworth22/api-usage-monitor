# API Usage Monitor Sync Extension

This Chrome Extension automatically syncs API keys, usage tokens, and active session identifiers from provider dashboards (e.g., Anthropic Console, OpenAI Platform) directly to your local or hosted API Usage Monitor.

## Installation (Unpacked)

Since this extension handles sensitive API keys, it is not published to the Chrome Web Store. You must load it locally.

1. Open Google Chrome.
2. Navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle switch in the top right corner.
4. Click the **Load unpacked** button.
5. Select the `chrome-extension/` directory located inside your `API-usage-monitor` repository.

## Configuration

1. Click the **API Usage Monitor Sync** extension icon in your Chrome toolbar.
2. Enter your **Monitor API URL** (e.g., `http://localhost:4103` for local development, or your production Render URL like `https://usage.jays.services`).
3. Enter your **USAGE_INGEST_TOKEN** (the same token configured in your `.env` or Render environment variables).
4. Click **Save Configuration**.

## How it Works

Once configured, the extension will automatically inject scripts when you visit supported provider dashboards (currently `console.anthropic.com` and `platform.openai.com`).

The scripts will extract your active session tokens or API keys and securely `POST` them to your API Usage Monitor's `/api/ingest/keys` endpoint. The backend will automatically upsert the tokens into your provider's configuration.

You can verify it worked by checking the `config` JSON in your `Provider` settings on your API Usage Monitor dashboard.
