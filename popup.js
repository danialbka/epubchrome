const SETTINGS_KEY = "epublySettings";
const PAIRING_KEY = "epublyPairing";
const DEFAULT_SITE_URL = "https://www.epubly.net";

const connectButton = document.getElementById("connectButton");
const uploadButton = document.getElementById("uploadButton");
const disconnectButton = document.getElementById("disconnectButton");
const convertButton = document.getElementById("convertButton");
const statusElement = document.getElementById("status");
const statusLinkElement = document.getElementById("statusLink");
const pageTitleElement = document.getElementById("pageTitle");
const connectionStateElement = document.getElementById("connectionState");
const connectionMetaElement = document.getElementById("connectionMeta");

let activeTabId = null;

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  pageTitleElement.textContent = tab?.title?.trim() || "Current tab";

  await refreshUi();

  connectButton.addEventListener("click", async () => {
    setBusy(true, "pairing");
    setStatus("Opening EPUBly connection page...");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "start-epubly-pairing",
        siteUrl: DEFAULT_SITE_URL
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Could not start EPUBly pairing.");
      }

      setStatus("Approve the connection in the EPUBly tab, then reopen the extension.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not start pairing.", "error");
    } finally {
      setBusy(false);
      await refreshUi();
    }
  });

  disconnectButton.addEventListener("click", async () => {
    setBusy(true, "disconnect");
    try {
      const response = await chrome.runtime.sendMessage({
        type: "disconnect-epubly"
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Could not disconnect EPUBly.");
      }

      setStatus("Disconnected EPUBly.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not disconnect EPUBly.", "error");
    } finally {
      setBusy(false);
      await refreshUi();
    }
  });

  uploadButton.addEventListener("click", async () => {
    if (!activeTabId) {
      setStatus("No active tab found.", "error");
      return;
    }

    const settings = await readSettings();
    if (!settings.apiBaseUrl || !settings.accessToken) {
      setStatus("Connect EPUBly first.", "error");
      return;
    }

    setBusy(true, "upload");
    setStatus("Extracting and uploading...");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "upload-tab-to-epubly",
        tabId: activeTabId,
        apiBaseUrl: settings.apiBaseUrl,
        accessToken: settings.accessToken
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Upload failed.");
      }

      setStatus(response.bookUrl ? "Uploaded to your library." : `Uploaded ${response.filename}`);
      setStatusLink(response.bookUrl, "Open library");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Upload failed.", "error");
    } finally {
      setBusy(false);
      await refreshUi();
    }
  });

  convertButton.addEventListener("click", async () => {
    if (!activeTabId) {
      setStatus("No active tab found.", "error");
      return;
    }

    setBusy(true, "download");
    setStatus("Extracting content...");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "convert-tab-to-epub",
        tabId: activeTabId
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Conversion failed.");
      }

      setStatus(`Saved as ${response.filename}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Conversion failed.", "error");
    } finally {
      setBusy(false);
      await refreshUi();
    }
  });
}

async function refreshUi() {
  const [settings, pairing] = await Promise.all([readSettings(), readPairing()]);
  const isConnected = Boolean(settings.apiBaseUrl && settings.accessToken);
  const isPairing = Boolean(pairing?.nonce);

  if (isConnected) {
    connectionStateElement.textContent = "Connected";
    connectionMetaElement.textContent = settings.appBaseUrl
      ? `Uploads go to ${settings.appBaseUrl}`
      : "EPUBChrome can upload directly into your library.";
  } else if (isPairing) {
    connectionStateElement.textContent = "Awaiting approval";
    connectionMetaElement.textContent = `Finish approval in the EPUBly tab for ${pairing.siteUrl || DEFAULT_SITE_URL}.`;
  } else {
    connectionStateElement.textContent = "Not connected";
    connectionMetaElement.textContent = "Connect EPUBChrome to upload directly into your library.";
  }

  uploadButton.disabled = !isConnected;
  disconnectButton.disabled = !isConnected && !isPairing;
}

async function readSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return stored?.[SETTINGS_KEY] || {};
}

async function readPairing() {
  const stored = await chrome.storage.local.get(PAIRING_KEY);
  return stored?.[PAIRING_KEY] || null;
}

function normalizeUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function setBusy(isBusy, mode = "idle") {
  connectButton.disabled = isBusy;
  disconnectButton.disabled = isBusy;
  uploadButton.disabled = isBusy;
  convertButton.disabled = isBusy;

  connectButton.textContent = isBusy && mode === "pairing" ? "Connecting..." : "Connect to EPUBly";
  disconnectButton.textContent = isBusy && mode === "disconnect" ? "Disconnecting..." : "Disconnect EPUBly";
  uploadButton.textContent = isBusy && mode === "upload" ? "Uploading..." : "Upload to EPUBly";
  convertButton.textContent = isBusy && mode === "download" ? "Downloading..." : "Download EPUB";
}

function setStatus(message, state = "info") {
  statusElement.textContent = message;
  statusElement.dataset.state = state;
  setStatusLink(null);
}

function setStatusLink(url, label = "Open") {
  if (!url) {
    statusLinkElement.hidden = true;
    statusLinkElement.removeAttribute("href");
    statusLinkElement.textContent = "";
    return;
  }

  statusLinkElement.href = url;
  statusLinkElement.textContent = label;
  statusLinkElement.hidden = false;
}
