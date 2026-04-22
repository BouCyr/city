const STEP_LABELS = [
  "Seed random stream",
  "Shape terrain",
  "Place district centers",
  "Lay road network",
  "Carve neighborhood blocks",
  "Drop landmarks",
  "Render summary",
];

export function createStepTracker({ listElement, statusElement }) {
  let activeIndex = -1;

  function render(status = "Idle") {
    listElement.innerHTML = "";
    STEP_LABELS.forEach((label, index) => {
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
      activeIndex = STEP_LABELS.length;
      render("Complete");
    },
  };
}
