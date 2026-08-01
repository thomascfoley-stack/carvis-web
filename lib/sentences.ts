/**
 * Incremental sentence splitter.
 *
 * The whole point: hand the TTS engine a speakable chunk the instant one
 * exists, instead of waiting for the model to finish. The first chunk is
 * allowed to be very short ("Afraid not.") because it sets time-to-first-audio;
 * later chunks are held longer so the delivery doesn't sound clipped.
 */

const ABBREVIATIONS = [
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt",
  "etc", "vs", "approx", "inc", "ltd", "co",
  "e.g", "i.e", "a.m", "p.m", "u.s", "u.k",
];

const SOFT_BREAK = /[,;:—–]/;

function isRealBoundary(buf: string, i: number): boolean {
  const ch = buf[i];
  if (ch === "\n") return true;
  if (ch === "!" || ch === "?" || ch === "…") return true;
  if (ch !== ".") return false;

  const next = buf[i + 1];
  // Needs whitespace (or end of buffer) after it to count as a sentence end.
  if (next !== undefined && !/\s/.test(next)) return false;

  const prev = buf[i - 1];
  // Decimals: "3.5", version numbers.
  if (prev && /\d/.test(prev) && next && /\d/.test(next)) return false;

  // Initials: "J. Smith".
  if (prev && /[A-Z]/.test(prev) && (!buf[i - 2] || /\s/.test(buf[i - 2]))) return false;

  const before = buf.slice(Math.max(0, i - 12), i).toLowerCase();
  for (const abbr of ABBREVIATIONS) {
    if (before.endsWith(abbr)) return false;
  }
  return true;
}

export function createSentenceStream(opts?: {
  firstMin?: number;
  laterMin?: number;
  softAt?: number;
  hardAt?: number;
}) {
  const firstMin = opts?.firstMin ?? 2;
  const laterMin = opts?.laterMin ?? 25;
  const softAt = opts?.softAt ?? 140;
  const hardAt = opts?.hardAt ?? 260;

  let buffer = "";
  let emitted = 0;

  const minLen = () => (emitted === 0 ? firstMin : laterMin);

  const take = (upTo: number): string => {
    const chunk = buffer.slice(0, upTo).trim();
    buffer = buffer.slice(upTo);
    emitted++;
    return chunk;
  };

  return {
    /** Feed a token delta; returns zero or more chunks ready to speak. */
    push(delta: string): string[] {
      buffer += delta;
      const out: string[] = [];

      let guard = 0;
      while (guard++ < 50) {
        let cut = -1;

        for (let i = 0; i < buffer.length; i++) {
          if (isRealBoundary(buffer, i) && i + 1 >= minLen()) {
            cut = i + 1;
            break;
          }
        }

        // Long clause with no terminator yet — break on punctuation so the
        // speaker isn't left waiting on a run-on sentence.
        if (cut === -1 && buffer.length > softAt) {
          for (let i = softAt; i < buffer.length; i++) {
            if (SOFT_BREAK.test(buffer[i])) {
              cut = i + 1;
              break;
            }
          }
        }

        // Absolute backstop.
        if (cut === -1 && buffer.length > hardAt) {
          const sp = buffer.lastIndexOf(" ", hardAt);
          cut = sp > 40 ? sp : hardAt;
        }

        if (cut === -1) break;

        const chunk = take(cut);
        if (chunk) out.push(chunk);
      }

      return out;
    },

    /** Whatever is left at end of stream. */
    flush(): string {
      const rest = buffer.trim();
      buffer = "";
      if (rest) emitted++;
      return rest;
    },
  };
}
