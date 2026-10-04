// Notification sounds — synthesized with WebAudio so no audio files ship.
// Each preset is a short, soft motif (sine tones, quick decay) — audible on
// speakers, gentle enough not to startle. Off is a valid choice.

export type SoundId = "none" | "chime" | "pop" | "drop" | "bloom";

const K_SOUND = "relay.notify.sound";

export const SOUNDS: { id: SoundId; label: string; hint: string }[] = [
  { id: "chime", label: "Chime", hint: "soft two-tone bell" },
  { id: "pop", label: "Pop", hint: "short rounded blip" },
  { id: "drop", label: "Drop", hint: "gentle falling tone" },
  { id: "bloom", label: "Bloom", hint: "warm rising swell" },
  { id: "none", label: "Off", hint: "silent notifications" },
];

export function notifySound(): SoundId {
  const v = localStorage.getItem(K_SOUND) as SoundId | null;
  return v && SOUNDS.some((s) => s.id === v) ? v : "chime";
}

export function setNotifySound(id: SoundId) {
  localStorage.setItem(K_SOUND, id);
}

// Note table: [frequency Hz, start offset s, duration s]
const MOTIFS: Record<Exclude<SoundId, "none">, [number, number, number][]> = {
  chime: [
    [880, 0, 0.16],
    [1318.5, 0.09, 0.22],
  ],
  pop: [[660, 0, 0.07]],
  drop: [
    [1046.5, 0, 0.1],
    [783.99, 0.08, 0.18],
  ],
  bloom: [
    [523.25, 0, 0.22],
    [659.25, 0.05, 0.22],
    [987.77, 0.12, 0.3],
  ],
};

let ctx: AudioContext | null = null;

export function playSound(id: SoundId) {
  if (id === "none") return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    for (const [freq, at, dur] of MOTIFS[id]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + at);
      gain.gain.linearRampToValueAtTime(0.12, now + at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + dur + 0.05);
    }
  } catch {
    /* webviews without audio — silent no-op */
  }
}
