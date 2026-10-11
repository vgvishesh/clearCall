/** User-facing copy for error codes. The controller reports codes; only the UI words them. */
import type { CallErrorCode } from "../core/types.ts";
import type { Platform } from "./platform.ts";

/** UI-only code for "the app itself failed to start" (e.g. controller factory threw). */
export type ScreenErrorCode = CallErrorCode | "app-failed";

export type ErrorAction = "retry" | "new-call" | "reload";

export interface ErrorCopy {
  title: string;
  body: string;
  actions: ErrorAction[];
}

export function errorCopy(code: ScreenErrorCode): ErrorCopy {
  switch (code) {
    case "room-full":
      return {
        title: "This call is full",
        body: "Calls have room for 10 people. Try again when someone leaves, or start a new call.",
        actions: ["retry", "new-call"],
      };
    case "invalid-link":
      return {
        title: "This link doesn’t work",
        body: "It may be incomplete. Ask for the link again, or start a new call.",
        actions: ["new-call"],
      };
    case "unsupported":
      return {
        title: "This browser can’t make calls",
        body: "Open the link in Safari on iPhone or iPad, or in Chrome, Edge, Firefox or Safari elsewhere.",
        actions: [],
      };
    case "signaling-unavailable":
      return {
        title: "Can’t reach Clearcall",
        body: "Check your internet connection and try again.",
        actions: ["retry"],
      };
    case "version-mismatch":
      return {
        title: "Clearcall was updated",
        body: "Reload to get the latest version, then join again.",
        actions: ["reload"],
      };
    case "permission-denied":
    case "no-devices":
      return {
        title: "Camera and microphone unavailable",
        body: "Allow access to your camera and microphone, then try again.",
        actions: ["retry"],
      };
    default:
      return {
        title: "Something went wrong",
        body: "Clearcall couldn’t start. Reload to try again.",
        actions: ["reload"],
      };
  }
}

/** One line on the Ended screen when the call ended because of an error rather than the user leaving. */
export function endedReason(code: CallErrorCode | undefined): string | null {
  if (!code) return null;
  if (code === "version-mismatch") return "Clearcall was updated. Reload to rejoin.";
  if (code === "signaling-unavailable") return "The connection was lost for too long.";
  return "The call ended unexpectedly.";
}

export interface DeviceHelp {
  title: string;
  body: string;
  steps: string | null;
}

/** Lobby copy when camera and/or microphone can't be used. */
export function deviceHelp(
  code: "permission-denied" | "no-devices",
  camAvailable: boolean,
  micAvailable: boolean,
  platform: Platform,
): DeviceHelp {
  const what =
    !camAvailable && !micAvailable ? "camera and microphone" : !camAvailable ? "camera" : "microphone";
  if (code === "no-devices") {
    return {
      title: `No ${what} available`,
      body: `It may be in use by another app. Close that app, then try again.`,
      steps: null,
    };
  }
  const steps =
    platform === "ios"
      ? "Open Settings › Safari › Camera and Microphone, choose Allow, then try again."
      : platform === "android"
        ? "Tap the lock icon by the address, open Permissions, allow Camera and Microphone, then try again."
        : "Click the camera icon in the address bar, allow access, then try again.";
  return {
    title: `${capitalize(what)} ${what.includes(" and ") ? "are" : "is"} blocked`,
    body: "Access was blocked.",
    steps,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
