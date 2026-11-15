// Start Solving World Problems workspace.
// PLACEHOLDER: nothing is researched or sent anywhere. The form only shows the interface.
// It will be connected to the research and problem-solving engine in a later roadmap phase.

const AREAS = ["Health", "Climate", "Education", "Energy", "Water and food", "Economy", "Other"];

export function createWorld({ formEl, topicEl, areasEl, stateEl, resultEl, resultTextEl }) {
  let selected = null;

  for (const name of AREAS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = name;
    chip.setAttribute("aria-pressed", "false");
    chip.addEventListener("click", () => {
      selected = selected === name ? null : name;
      for (const c of areasEl.children) {
        const on = c.textContent === selected;
        c.classList.toggle("selected", on);
        c.setAttribute("aria-pressed", String(on));
      }
    });
    areasEl.appendChild(chip);
  }

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const topic = topicEl.value.trim();
    if (!topic) {
      stateEl.textContent = "Describe a problem first.";
      topicEl.focus();
      return;
    }
    stateEl.textContent = "Draft only \u00b7 nothing is sent anywhere";
    const short = topic.length > 90 ? topic.slice(0, 90) + "..." : topic;
    resultTextEl.textContent =
      `Research did not start. Your draft ("${short}"${selected ? `, focus: ${selected}` : ""}) was not saved or sent. ` +
      "When the research engine is connected, this is where progress, sources and proposed solutions will appear.";
    resultEl.hidden = false;
  });

  topicEl.addEventListener("input", () => {
    stateEl.textContent = "Draft only \u00b7 nothing is sent anywhere";
  });
}
