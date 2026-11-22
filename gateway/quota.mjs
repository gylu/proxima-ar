export const dailyLimits = Object.freeze({ questions: 25, voiceSeconds: 300 });
export const utcDay = () => new Date().toISOString().slice(0, 10);

export class PublicError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function exhausted(kind) {
  const allowance = kind === 'questions' ? '25 AI questions' : 'five minutes of voice';
  return new PublicError(429, 'daily_limit', 'The public demo has used its daily allowance of ' + allowance + '. It resets at 00:00 UTC.');
}

export function createQuota(store, today = utcDay) {
  const full = new Map();
  return {
    async take(kind, amount, day = today()) {
      if (!Object.hasOwn(dailyLimits, kind) || !Number.isSafeInteger(amount) || amount < 1)
        throw new Error('Invalid quota reservation');
      if (day !== today() || full.get(kind) === day) throw exhausted(kind);
      for (let attempt = 0; attempt < 8; attempt++) {
        const { usage, generation } = await store.read(day);
        for (const key of Object.keys(dailyLimits)) {
          if (!Number.isSafeInteger(usage[key]) || usage[key] < 0 || usage[key] > dailyLimits[key])
            throw new Error('Invalid stored quota');
        }
        if (usage[kind] === dailyLimits[kind]) full.set(kind, day);
        if (day !== today() || usage[kind] + amount > dailyLimits[kind]) throw exhausted(kind);
        const next = { ...usage, [kind]: usage[kind] + amount };
        if (await store.write(day, next, generation)) {
          if (next[kind] === dailyLimits[kind]) full.set(kind, day);
          return;
        }
      }
      throw new PublicError(503, 'quota_busy', 'Unable to reserve capacity. Please try again shortly.');
    },
  };
}
