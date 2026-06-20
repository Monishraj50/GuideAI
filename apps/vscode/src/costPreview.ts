// Phase 5 (P3) — Cost preview confirmation.
//
// Before any paid action, show a small modal: ~$X.XX, ~Y min. Continue?
// Local heuristic only — the orchestrator's forecastPhaseCost runs server-side
// and could be wired in via API later for precise numbers.
//
// Setting: atrune.showCostPreview (default true). Power users can disable.

import * as vscode from 'vscode';

export interface BriefForecast {
  usd: number;
  minutes: number;
}

export function forecastBrief(body: string, agentCount: number): BriefForecast {
  // Coarse local estimate. Calibrated against rough averages from the
  // discovery → plan → implement → review → verify pipeline.
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  const baseUsd = 0.08;
  const perAgentUsd = 0.04;
  const perWordUsd = 0.0006;
  const usd = baseUsd + agentCount * perAgentUsd + words * perWordUsd;
  // Roughly: 1 min per phase + 30s per agent. Floor at 3 min.
  const minutes = Math.max(3, 5 + agentCount * 0.5);
  return { usd, minutes };
}

export function isPreviewEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('atrune')
    .get<boolean>('showCostPreview', true);
}

/**
 * Show the modal. Returns true if the user confirmed, false if they cancelled
 * (or the setting is off, in which case we silently proceed).
 */
export async function confirmCost(
  forecast: BriefForecast,
  actionLabel: string,
): Promise<boolean> {
  if (!isPreviewEnabled()) return true;

  const usd = forecast.usd.toFixed(2);
  const minutes = Math.round(forecast.minutes);
  const message =
    `${actionLabel} will spend roughly $${usd} and take about ${minutes} min. ` +
    `Continue?`;

  const pick = await vscode.window.showInformationMessage(
    message,
    { modal: true },
    'Continue',
    "Don't show again",
  );

  if (pick === "Don't show again") {
    await vscode.workspace
      .getConfiguration('atrune')
      .update('showCostPreview', false, vscode.ConfigurationTarget.Global);
    return true;
  }

  return pick === 'Continue';
}
