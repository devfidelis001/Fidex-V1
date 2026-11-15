// A small message that appears at the bottom of the window for a moment.

export function createToast(el) {
  let timer = null;
  return function show(message, ms = 2600) {
    el.textContent = message;
    el.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      el.hidden = true;
    }, ms);
  };
}
