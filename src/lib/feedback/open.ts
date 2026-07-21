"use client";

/**
 * The single client entry point for opening the feedback sheet. Any surface —
 * the account menu, the error boundary, a future contextual button — dispatches
 * this event; the app-wide FeedbackRuntime listens and opens. Decouples the
 * triggers from the sheet so there's exactly one sheet, mounted once.
 */
export const FEEDBACK_EVENT = "numbers:feedback";

export interface OpenFeedbackDetail {
  category?: string;
}

export function openFeedback(detail: OpenFeedbackDetail = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FEEDBACK_EVENT, { detail }));
}
