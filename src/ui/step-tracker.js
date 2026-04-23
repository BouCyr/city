/*
 * WHAT: Manage the step list UI that reflects generation progress and replay selection.
 * HOW: Re-render the ordered list whenever the active or selected step changes.
 * WHY: The generator needs a lightweight status view without coupling map logic to the DOM.
 */

import { GENERATION_STEPS } from "../generator/steps.js";

const STATUS_IDLE = "Idle";
const STATUS_COMPLETE = "Complete";
const STEP_RENDER_DELAY_MS = 120;
const STEP_SELECTION_KEYS = new Set(["Enter", " "]);

/**
 * WHAT: Create a small stateful controller around the step list and status badge.
 * HOW: Track the active and selected indices locally, then rebuild the list with the right classes and handlers.
 * WHY: The replay UI needs one source of truth for which step is running and which frame is currently selected.
 */
export function createStepTracker({ listElement, statusElement, onStepSelect }) {
  let activeIndex = -1;
  let selectedIndex = -1;

  function render(status = STATUS_IDLE) {
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
        if (STEP_SELECTION_KEYS.has(event.key)) {
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
      render(STATUS_IDLE);
    },
    async advance(index, status, work) {
      activeIndex = index;
      render(status);
      await new Promise((resolve) => window.setTimeout(resolve, STEP_RENDER_DELAY_MS));
      return work();
    },
    complete() {
      activeIndex = GENERATION_STEPS.length;
      render(STATUS_COMPLETE);
    },
    setSelectedStep(index) {
      selectedIndex = index;
      render(activeIndex >= GENERATION_STEPS.length ? STATUS_COMPLETE : STATUS_IDLE);
    },
  };
}
