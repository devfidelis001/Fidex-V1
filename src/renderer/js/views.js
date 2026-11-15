// Switching between the welcome screen and the workspace.
// The welcome screen appears instantly, then the workspace opens automatically
// after a few seconds. A click or any key skips straight to the workspace.

const AUTO_ENTER_MS = 3500;

export function createViews({ welcomeEl, workspaceEl, onEnterWorkspace }) {
  let timer = null;

  function enterWorkspace() {
    clearTimeout(timer);
    document.removeEventListener("click", enterWorkspace);
    document.removeEventListener("keydown", enterWorkspace);
    welcomeEl.hidden = true;
    workspaceEl.hidden = false;
    onEnterWorkspace();
  }

  function showWelcome() {
    workspaceEl.hidden = true;
    welcomeEl.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(enterWorkspace, AUTO_ENTER_MS);
    // Delay attaching the skip handlers so the click that opened the welcome screen doesn't skip it.
    setTimeout(() => {
      if (welcomeEl.hidden) return;
      document.addEventListener("click", enterWorkspace);
      document.addEventListener("keydown", enterWorkspace);
    }, 0);
  }

  return { showWelcome, enterWorkspace };
}
