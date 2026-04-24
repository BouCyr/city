/*
 * WHAT: Manage the step list UI that reflects generation progress and replay selection.
 * HOW: Re-render the ordered list whenever the active or selected step changes.
 * WHY: The generator needs a lightweight status view without coupling map logic to the DOM.
 */

import { GENERATION_STEPS, GENERATION_STEP_TREE } from "../generator/steps.js";

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
  const durationByStepIndex = new Map();

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

  function render(status = STATUS_IDLE) {
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

          item.appendChild(
            buildItemLabel(
              `${groupIndex + 1}.${childIndex + 1}`,
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
    statusElement.textContent = status;
  }

  render();

  return {
    reset() {
      activeIndex = -1;
      selectedIndex = -1;
      durationByStepIndex.clear();
      render(STATUS_IDLE);
    },
    async advance(index, status, work) {
      activeIndex = index;
      render(status);
      await new Promise((resolve) => window.setTimeout(resolve, STEP_RENDER_DELAY_MS));
      const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      const result = await work();
      const finishedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      durationByStepIndex.set(index, finishedAt - startedAt);
      render(status);
      return result;
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
