// Whether this browser can run the voice chat: it needs a microphone, a recorder and Web Audio.
export const voiceSupported = () => Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined' && Boolean(window.AudioContext || window.webkitAudioContext);
