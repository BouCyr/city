import { GENERATION_STEPS } from "../generator/steps.js";

export function createStepTracker({ listElement, statusElement }) {
  let activeIndex = -1;

  function render(status = "Idle") {
    listElement.innerHTML = "";
    GENERATION_STEPS.forEach((label, index) => {
      const item = document.createElement("li");
      item.textContent = label;
      if (index < activeIndex) {
        item.className = "complete";
      } else if (index === activeIndex) {
        item.className = "active";
      }
      listElement.appendChild(item);
    });
    statusElement.textContent = status;
  }

  render();

  return {
    reset() {
      activeIndex = -1;
      render("Idle");
    },
    async advance(index, status, work) {
      activeIndex = index;
      render(status);
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      return work();
    },
    complete() {
      activeIndex = GENERATION_STEPS.length;
      render("Complete");
    },
  };
}
