// Shared by the voice chat UI tests: a fake microphone, an in-page transcription answer, and a WAV tone for the fake speech provider.
// One second of a quiet 220 Hz tone as a 16-bit mono WAV.
export function wav(seconds = 1, rate = 22050) {
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 3000), 44 + i * 2);
  return buf;
}

export const FAKES = `
  navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
  window.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() { this.mimeType = 'audio/webm'; this.state = 'inactive'; this.on = {}; }
    set ondataavailable(fn) { this.on.dataavailable = fn; }
    set onstop(fn) { this.on.stop = fn; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.on.dataavailable({ data: new Blob(['webm-bytes'], { type: 'audio/webm' }) }); this.on.stop(); }
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, init) => {
    if (/\\/uploads\\/[^/]+\\/transcribe$/.test(String(url))) return Promise.resolve(new Response('{"text":"halo"}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    return realFetch(url, init);
  };
`;

