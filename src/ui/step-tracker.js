/*
 * WHAT: Manage the step list UI that reflects generation progress and replay selection.
 * HOW: Re-render the ordered list whenever the active or selected step changes.
 * WHY: The generator needs a lightweight status view without coupling map logic to the DOM.
 */

import { GENERATION_STEPS, GENERATION_STEP_TREE } from "../generator/steps.js";

const STATUS_IDLE = "Idle";
const STATUS_COMPLETE = "Complete";
const STEP_SELECTION_KEYS = new Set(["Enter", " "]);
const GEOGRAPHICAL_STEP_NUMBERS = [
  "1.1",
  "1.2",
  "1.3",
  "1.4",
  "1.5",
  "1.6",
  "1.7",
  "1.8",
  "1.9",
  "1.10",
];

/**
 * WHAT: Create a small stateful controller around the step list and status badge.
 * HOW: Track the active and selected indices locally, then rebuild the list with the right classes and handlers.
 * WHY: The replay UI needs one source of truth for which step is running and which frame is currently selected.
 */
export function createStepTracker({ listElement, statusElement, onStepSelect }) {
  let activeIndex = -1;
  let selectedIndex = -1;
  const durationByStepIndex = new Map();
  let currentStatus = STATUS_IDLE;

  function getStepState(index) {
    if (index < activeIndex) {
      return "complete";
    }
    if (index === activeIndex) {
      return "active";
    }
    return "idle";
  }

  function getGroupState(stepIndices) {
    if (stepIndices.length === 0) {
      return "idle";
    }
    const allComplete = stepIndices.every((index) => index < activeIndex);
    if (allComplete) {
      return "complete";
    }
    const hasActive = stepIndices.includes(activeIndex);
    if (hasActive) {
      return "active";
    }
    return "idle";
  }

  function buildItemLabel(numbering, label, durationMs) {
    const content = document.createElement("span");
    content.className = "step-item-content";

    const labelSpan = document.createElement("span");
    labelSpan.className = "step-label";
    labelSpan.textContent = `${numbering} ${label}`;
    content.appendChild(labelSpan);

    if (typeof durationMs === "number") {
      const durationSpan = document.createElement("span");
      durationSpan.className = "step-duration";
      durationSpan.textContent = `${Math.round(durationMs)} ms`;
      content.appendChild(durationSpan);
    }

    return content;
  }

  function render(status = currentStatus) {
    currentStatus = status;
    listElement.innerHTML = "";
    GENERATION_STEP_TREE.forEach((group, groupIndex) => {
      const groupItem = document.createElement("li");
      groupItem.className = "step-group";

      const groupState = getGroupState(group.stepIndices);
      if (groupState !== "idle") {
        groupItem.classList.add(groupState);
      }
      if (group.stepIndices.includes(selectedIndex)) {
        groupItem.classList.add("current");
      }

      const groupDurationMs = group.stepIndices.reduce((sum, index) => sum + (durationByStepIndex.get(index) ?? 0), 0);
      const groupHeader = buildItemLabel(
        String(groupIndex + 1),
        group.label,
        groupDurationMs > 0 ? groupDurationMs : null
      );
      groupHeader.classList.add("step-group-label");
      groupItem.appendChild(groupHeader);

      if (group.stepIndices.length > 0) {
        const subList = document.createElement("ol");
        subList.className = "steps-sublist";

        group.stepIndices.forEach((index, childIndex) => {
          const item = document.createElement("li");
          item.dataset.stepIndex = String(index);
          item.tabIndex = 0;

          const stepState = getStepState(index);
          if (stepState !== "idle") {
            item.classList.add(stepState);
          }
          if (index === selectedIndex) {
            item.classList.add("current");
          }

          const stepNumber = GEOGRAPHICAL_STEP_NUMBERS[index] || `${groupIndex + 1}.${childIndex + 1}`;
          item.appendChild(
            buildItemLabel(
              stepNumber,
              GENERATION_STEPS[index],
              durationByStepIndex.get(index)
            )
          );

          item.addEventListener("click", () => onStepSelect?.(index));
          item.addEventListener("keydown", (event) => {
            if (STEP_SELECTION_KEYS.has(event.key)) {
              event.preventDefault();
              onStepSelect?.(index);
            }
          });
          subList.appendChild(item);
        });

        groupItem.appendChild(subList);
      }

      listElement.appendChild(groupItem);
    });
    statusElement.textContent = currentStatus;
  }

  render();

  return {
    reset() {
      activeIndex = -1;
      selectedIndex = -1;
      durationByStepIndex.clear();
      currentStatus = STATUS_IDLE;
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
