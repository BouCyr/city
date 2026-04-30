/*
 * WHAT: Manage the step list UI that reflects generation progress and selected visualization step.
 * HOW: Bind to static step list items, then toggle classes and duration labels by step index.
 * WHY: Step controls now live inside each step row, so the tracker should not re-render DOM structure.
 */

import { GENERATION_STEPS } from "../generator/steps.js";

const STATUS_IDLE = "Idle";
const STATUS_COMPLETE = "Complete";
const STEP_SELECTION_KEYS = new Set(["Enter", " "]);

export function createStepTracker({ listElement, statusElement, onStepSelect }) {
  let activeIndex = -1;
  let selectedIndex = -1;
  let currentStatus = STATUS_IDLE;
  const durationByStepIndex = new Map();
  const stepItems = new Map();

  Array.from(listElement.querySelectorAll("[data-step-index]")).forEach((item) => {
    const index = Number(item.getAttribute("data-step-index"));
    if (!Number.isFinite(index)) {
      return;
    }

    const durationElement = document.createElement("span");
    durationElement.className = "step-duration";
    durationElement.hidden = true;
    item.querySelector(".step-select")?.append(durationElement);
    stepItems.set(index, { item, durationElement });

    const select = () => onStepSelect?.(index);
    item.querySelector(".step-select")?.addEventListener("click", select);
    item.querySelector(".step-select")?.addEventListener("keydown", (event) => {
      if (!STEP_SELECTION_KEYS.has(event.key)) {
        return;
      }
      event.preventDefault();
      select();
    });
  });

  function stepState(index) {
    if (index < activeIndex) {
      return "complete";
    }
    if (index === activeIndex) {
      return "active";
    }
    return "idle";
  }

  function render(status = currentStatus) {
    currentStatus = status;
    stepItems.forEach(({ item, durationElement }, index) => {
      item.classList.remove("active", "complete", "current");
      const state = stepState(index);
      if (state !== "idle") {
        item.classList.add(state);
      }
      if (index === selectedIndex) {
        item.classList.add("current");
      }

      const durationMs = durationByStepIndex.get(index);
      if (typeof durationMs === "number") {
        durationElement.textContent = `${Math.round(durationMs)} ms`;
        durationElement.hidden = false;
      } else {
        durationElement.hidden = true;
      }
    });
    statusElement.textContent = currentStatus;
  }

  render();

  return {
    reset() {
      activeIndex = -1;
      selectedIndex = -1;
      durationByStepIndex.clear();
      render(STATUS_IDLE);
    },
    startStep(index, status) {
      activeIndex = index;
      render(status);
    },
    finishStep(index, durationMs, status = currentStatus) {
      activeIndex = index;
      if (typeof durationMs === "number") {
        durationByStepIndex.set(index, durationMs);
      }
      render(status);
    },
    complete() {
      activeIndex = GENERATION_STEPS.length;
      render(STATUS_COMPLETE);
    },
    setCompletedRun(stepDurations = []) {
      activeIndex = GENERATION_STEPS.length;
      durationByStepIndex.clear();
      stepDurations.forEach((durationMs, index) => {
        if (typeof durationMs === "number") {
          durationByStepIndex.set(index, durationMs);
        }
      });
      render(STATUS_COMPLETE);
    },
    setSelectedStep(index) {
      selectedIndex = index;
      render(activeIndex >= GENERATION_STEPS.length ? STATUS_COMPLETE : currentStatus);
    },
  };
}
