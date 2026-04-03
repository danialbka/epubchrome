const convertButton = document.getElementById("convertButton");
const statusElement = document.getElementById("status");
const pageTitleElement = document.getElementById("pageTitle");

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const title = tab?.title?.trim() || "Current tab";
  pageTitleElement.textContent = title;

  convertButton.addEventListener("click", async () => {
    if (!tab?.id) {
      setStatus("No active tab found.", "error");
      return;
    }

    setBusy(true);
    setStatus("Extracting content...");

    try {
      const response = await chrome.runtime.sendMessage({
        type: "convert-tab-to-epub",
        tabId: tab.id
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Conversion failed.");
      }

      setStatus(`Saved as ${response.filename}`);
    } catch (error) {
      setStatus(error.message || "Conversion failed.", "error");
    } finally {
      setBusy(false);
    }
  });
}

function setBusy(isBusy) {
  convertButton.disabled = isBusy;
  convertButton.textContent = isBusy ? "Converting..." : "Convert current page";
}

function setStatus(message, state = "info") {
  statusElement.textContent = message;
  statusElement.dataset.state = state;
}
