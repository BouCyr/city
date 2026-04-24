/*
 * WHAT: Run deterministic map generation off the main thread and stream progress back to the UI.
 * HOW: Execute one requested task at a time, posting step updates for single generation and sample counters for seed searches.
 * WHY: Heavy generation should not block pointer input, repaint, or form interaction in the browser.
 */

import { generateCity } from "./city-generator.js";

self.addEventListener("message", async (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") {
    return;
  }

  try {
    if (message.type === "generate") {
      await handleGenerateRequest(message);
      return;
    }

    if (message.type === "best-of-50") {
      await handleBestOfRequest(message);
    }
  } catch (error) {
    postMessage({
      type: "task-error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

async function handleGenerateRequest({ requestId, options }) {
  const map = await generateCity(options, {
    reset() {
      postMessage({
        type: "generation-reset",
        requestId,
      });
    },
    onStepStart(payload) {
      postMessage({
        type: "generation-step-start",
        requestId,
        ...payload,
      });
    },
    onStepComplete(payload) {
      postMessage({
        type: "generation-step-complete",
        requestId,
        ...payload,
      });
    },
    complete(payload) {
      postMessage({
        type: "generation-finished-steps",
        requestId,
        ...payload,
      });
    },
  });

  postMessage({
    type: "generation-complete",
    requestId,
    map,
  });
}

async function handleBestOfRequest({ requestId, options, sampleCount, baseline }) {
  let bestCandidate = baseline
    ? {
      seed: baseline.seed,
      tributaryLength: baseline.tributaryLength,
      map: null,
      improved: false,
    }
    : null;

  postMessage({
    type: "best-of-start",
    requestId,
    sampleCount,
  });

  for (let index = 0; index < sampleCount; index += 1) {
    const seed = generateRandomSeed();
    const map = await generateCity({
      ...options,
      seed,
    });
    const tributaryLength = map.rivers?.[1]?.length || 0;

    postMessage({
      type: "best-of-progress",
      requestId,
      completedCount: index + 1,
      sampleCount,
    });

    if (!bestCandidate || tributaryLength > bestCandidate.tributaryLength) {
      bestCandidate = {
        seed,
        tributaryLength,
        map,
        improved: true,
      };
      postMessage({
        type: "best-of-better",
        requestId,
        completedCount: index + 1,
        sampleCount,
        seed,
        tributaryLength,
        map,
      });
    }
  }

  postMessage({
    type: "best-of-complete",
    requestId,
    sampleCount,
    seed: bestCandidate?.seed || null,
    tributaryLength: bestCandidate?.tributaryLength || 0,
    improved: bestCandidate?.improved === true,
    map: bestCandidate?.improved ? bestCandidate?.map || null : null,
  });
}

function generateRandomSeed() {
  return Math.random().toString(36).slice(2, 10);
}
