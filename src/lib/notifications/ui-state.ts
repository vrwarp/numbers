/**
 * §8.2/§8.4 notification UI state stored per account on User.notifyUiStateJson
 * (nudge dismissals + iOS onboarding resume step). Shared by the ui-state
 * route and anything server-side that needs to read it.
 */

export type NotifyUiState = {
  dismissedNudges: string[];
  /** §8.4 sequenced onboarding: 0 = not started/finished, 1-4 = mid-flow. */
  onboardingStep: number;
};

export function parseUiState(json: string): NotifyUiState {
  try {
    const parsed = JSON.parse(json) as Partial<NotifyUiState>;
    return {
      dismissedNudges: Array.isArray(parsed.dismissedNudges)
        ? parsed.dismissedNudges.filter((n): n is string => typeof n === "string").slice(0, 20)
        : [],
      onboardingStep:
        typeof parsed.onboardingStep === "number" && parsed.onboardingStep >= 0
          ? Math.min(4, Math.floor(parsed.onboardingStep))
          : 0,
    };
  } catch {
    return { dismissedNudges: [], onboardingStep: 0 };
  }
}
