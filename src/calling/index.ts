// @paxpia/core/calling — the platform-free 1:1 / group call state machine + the
// shared call copy/format helpers. The media plane (LiveKit / WebRTC), the video
// render (RTCView / VideoTrack / <video>), and navigation are injected per-platform;
// this module owns the phase logic, status text, end-reason mapping, the UUID-free
// peer-name resolver, and the call_log chip copy.
export * from './callMachine';
