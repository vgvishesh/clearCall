/**
 * data-testid values — the contract between the UI and E2E tests.
 * Per-participant elements also carry data-participant-id, data-name, data-status, data-mic, data-cam.
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
  enableAudio: "enable-audio",
  retryPeer: "retry-peer",
  // Ended / errors
  endedScreen: "ended-screen",
  rejoinButton: "rejoin-button",
  newCallButton: "new-call-button",
  errorScreen: "error-screen",
  errorCode: "error-code",
  // PWA
  installHint: "install-hint",
} as const;

export type TestId = (typeof TID)[keyof typeof TID];
