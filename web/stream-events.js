export async function* readEvents(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      const lines = (pending + (value || '')).split('\n');
      pending = lines.pop();
      if (done) lines.push(pending);
      for (const line of lines) if (line.trim()) yield JSON.parse(line);
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}
