/**
 * data-testid values — the contract between the UI and E2E tests.
 *
 * Per-participant tiles (participant-tile, self-tile) also carry data attributes:
 * - data-participant-id: the remote peer id; the self tile always has data-participant-id="self".
 * - data-name: display name ("" until known).
 * - data-status: the peer connection status (PeerConnectionStatus: connecting | connected | reconnecting | failed;
 *   always "connected" on the self tile).
 * - data-mic, data-cam: "true" | "false" — whether that participant's mic / camera is on.
 */
export const TID = {
  // Home
  startCall: "start-call",
  joinLinkInput: "join-link-input",
  joinLinkSubmit: "join-link-submit",
  // Lobby
  lobby: "lobby",
  nameInput: "name-input",
  joinButton: "join-button",
  lobbyPreview: "lobby-preview",
  micLevel: "mic-level",
  /** Lobby "Get ready" step (mediaRequest not-asked/asking): explains the browser prompt before it appears. */
  permissionPrime: "permission-prime",
  /** Lobby: "Turn on camera & mic" — calls requestMedia() from a tap. */
  allowMedia: "allow-media",
  /** Lobby "Get ready" secondary action: requestMedia({video:false}) — mic only. (Listen-only = joinButton.) */
  joinSoundOnly: "join-sound-only",
  /** Lobby: step-by-step help for the user's browser after camera/mic were blocked. */
  permissionHelp: "permission-help",
  /** Lobby notice when the page runs inside another app's browser (in-app / WebView). */
  inAppNotice: "in-app-notice",
  /** "Open in Chrome / Safari" — used both in the lobby in-app notice and on the `unsupported` error screen. */
  openInBrowser: "open-in-browser",
  /** "Copy link" next to openInBrowser (always shown with it). */
  copyLink: "copy-link",
  /** Lobby: "Try again" / "I've done it" after camera/mic were blocked or missing. */
  retryMedia: "retry-media",
  // Call
  callScreen: "call-screen",
  participantTile: "participant-tile",
  selfTile: "self-tile",
  participantCount: "participant-count",
  micToggle: "mic-toggle",
  camToggle: "cam-toggle",
  flipCamera: "flip-camera",
  shareLink: "share-link",
  moreMenu: "more-menu",
  musicModeToggle: "music-mode-toggle",
  leaveButton: "leave-button",
  reconnectingBanner: "reconnecting-banner",
  /** CallState.videoLimited === "paused": this device is overloaded, video paused to keep audio clear (ADR-0010). */
  videoPausedNotice: "video-paused-notice",
  enableAudio: "enable-audio",
  retryPeer: "retry-peer",
  /** Close button of a bottom sheet / panel (e.g. the More sheet). */
  sheetClose: "sheet-close",
  // Ended / errors
  endedScreen: "ended-screen",
  rejoinButton: "rejoin-button",
  newCallButton: "new-call-button",
  errorScreen: "error-screen",
  errorCode: "error-code",
  /** Error screen's primary recovery button (Try again / Reload). The Ended screen's Rejoin stays rejoinButton. */
  errorAction: "error-action",
  // PWA
  installHint: "install-hint",
  installHintDismiss: "install-hint-dismiss",
} as const;

export type TestId = (typeof TID)[keyof typeof TID];
