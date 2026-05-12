/*
 * WHAT: Compute near-exclave statistics from lot parcels and non-river borders.
 * HOW: Aggregate segment-by-segment border counts and lengths by neighboring parish IDs.
 * WHY: Both near-exclave steps need the same deterministic boundary analysis.
 */

import { pointDistance } from "./map-model.js";

const STEP_LABEL = "Step 2.3 / Near-exclave lots";

export function runNearExclaveStatistics(lots, segments) {
  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  const metricByLotId = new Map(lots.map((lot) => [lot.id, createBaseMetric()]));

  segments.forEach((segment) => {
    if (segment.features?.river) {
      return;
    }

    const leftLotId = segment.leftLotId;
    const rightLotId = segment.rightLotId;
    if (leftLotId === rightLotId) {
      return;
    }

    const leftLot = lotById.get(leftLotId);
    const rightLot = lotById.get(rightLotId);
    if (!leftLot || !rightLot) {
      return;
    }

    const leftParish = leftLot.parishId;
    const rightParish = rightLot.parishId;
    if (leftParish === null || leftParish === undefined || rightParish === null || rightParish === undefined) {
      return;
    }

    const length = Number.isFinite(segment.length)
      ? segment.length
      : pointDistance(segment.from, segment.to);

    const leftMetric = metricByLotId.get(leftLot.id);
    const rightMetric = metricByLotId.get(rightLot.id);

    if (leftParish === rightParish) {
      if (leftMetric) {
        leftMetric.sameParishBorderSegments += 1;
        leftMetric.sameParishBorderLength += length;
      }
      if (rightMetric) {
        rightMetric.sameParishBorderSegments += 1;
        rightMetric.sameParishBorderLength += length;
      }
      return;
    }

    if (leftMetric) {
      leftMetric.foreignParishBorderSegments += 1;
      leftMetric.foreignParishBorderLength += length;
      leftMetric.borderLengthByAdjacentParish[rightParish] = (leftMetric.borderLengthByAdjacentParish[rightParish] || 0) + length;
    }
    if (rightMetric) {
      rightMetric.foreignParishBorderSegments += 1;
      rightMetric.foreignParishBorderLength += length;
      rightMetric.borderLengthByAdjacentParish[leftParish] = (rightMetric.borderLengthByAdjacentParish[leftParish] || 0) + length;
    }
  });

  const metricEntries = lots.map((lot) => {
    const metric = metricByLotId.get(lot.id) || createBaseMetric();
    const nearExclave = isNearExclaveMetric(metric);
    return {
      lotId: lot.id,
      nearExclave,
      metrics: {
        ...metric,
        nearExclave,
      },
    };
  });

  return {
    lotEntries: metricEntries,
    lotMetricsById: buildMetricById(metricEntries),
    nearExclaveLotIds: metricEntries.filter((entry) => entry.nearExclave).map((entry) => entry.lotId),
    nearExclaveLotCount: metricEntries.filter((entry) => entry.nearExclave).length,
  };
}

export function applyNearExclaveStateToLots(lots, metricById) {
  return lots.map((lot) => {
    const entry = metricById.get(lot.id);
    if (!entry) {
      return {
        ...lot,
        borderLengthByAdjacentParish: {},
        nearExclave: false,
      };
    }

    return {
      ...lot,
      borderLengthByAdjacentParish: { ...entry.borderLengthByAdjacentParish },
      nearExclave: Boolean(entry.nearExclave),
    };
  });
}

export function nearExclaveRatio(metric) {
  if (!metric || !metric.foreignParishBorderLength) {
    return 0;
  }
  if (!metric.sameParishBorderLength) {
    return Number.POSITIVE_INFINITY;
  }
  return metric.foreignParishBorderLength / metric.sameParishBorderLength;
}

export function isNearExclaveMetric(metric) {
  return Boolean(
    (metric?.foreignParishBorderSegments || 0) > 0
    && metric.foreignParishBorderSegments > metric.sameParishBorderSegments,
  );
}

function buildMetricById(metricEntries) {
  const map = new Map();
  metricEntries.forEach((entry) => {
    map.set(entry.lotId, entry.metrics);
  });
  return map;
}

function createBaseMetric() {
  return {
    sameParishBorderSegments: 0,
    foreignParishBorderSegments: 0,
    sameParishBorderLength: 0,
    foreignParishBorderLength: 0,
    borderLengthByAdjacentParish: {},
    nearExclave: false,
  };
}

export function nearExclaveStepLabel() {
  return STEP_LABEL;
}
