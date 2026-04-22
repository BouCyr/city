import { GENERATION_STEPS } from "../generator/steps.js";

export function createStepTracker({ listElement, statusElement, onStepSelect }) {
  let activeIndex = -1;
  let selectedIndex = -1;

  function render(status = "Idle") {
    listElement.innerHTML = "";
    GENERATION_STEPS.forEach((label, index) => {
      const item = document.createElement("li");
      item.textContent = label;
      item.dataset.stepIndex = String(index);
      item.tabIndex = 0;
      if (index < activeIndex) {
        item.className = "complete";
      } else if (index === activeIndex) {
        item.className = "active";
      }
      if (index === selectedIndex) {
        item.classList.add("current");
      }
      item.addEventListener("click", () => onStepSelect?.(index));
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onStepSelect?.(index);
        }
      });
      listElement.appendChild(item);
    });
    statusElement.textContent = status;
  }

  render();

  return {
    reset() {
      activeIndex = -1;
      selectedIndex = -1;
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
    setSelectedStep(index) {
      selectedIndex = index;
      render(activeIndex >= GENERATION_STEPS.length ? "Complete" : "Idle");
    },
  };
}
