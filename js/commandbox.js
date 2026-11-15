// A reusable command input: text field or textarea + send button + microphone.
// Used by the home screen and by the Take Over page, so both behave identically.

export function createCommandBox({ formEl, inputEl, sendEl, micEl, onSubmit, onMic }) {
  const isTextarea = inputEl.tagName === "TEXTAREA";

  function autosize() {
    if (!isTextarea) return;
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
  }

  function sync() {
    sendEl.disabled = inputEl.value.trim() === "";
  }

  inputEl.addEventListener("input", () => {
    autosize();
    sync();
  });

  if (isTextarea) {
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        formEl.requestSubmit();
      }
    });
  }

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";
    autosize();
    sync();
    onSubmit(text);
  });

  if (micEl) micEl.addEventListener("click", () => onMic && onMic());

  return {
    focus: () => inputEl.focus(),
    setValue: (text) => {
      inputEl.value = text;
      autosize();
      sync();
    },
  };
}
