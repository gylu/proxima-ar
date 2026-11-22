import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { GuideError } from './guidance.mjs';
import { queryWithFallback } from './cerebras-fallback.mjs';

const marker = /^Proxima transport ID: ([a-f0-9]{32})[ \t]*\r?$/m;

function findTurn(messages, turns) {
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (!['system', 'developer'].includes(message.role)) continue;
    const parts = Array.isArray(message.content) ? message.content : [message];
    for (const part of parts) {
      const field = part === message ? 'content' : 'text';
      if (typeof part?.[field] !== 'string') continue;
      const match = part[field].match(marker);
      if (!match || !turns.has(match[1])) continue;
      part[field] = part[field].replace(marker, '').trim();
      return turns.get(match[1]);
    }
  }
}

function completion(res, text, metrics) {
  if (res.destroyed) return;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  const meta = {
    id: 'proxima-turn',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'visual-guide',
  };
  const write = (event) => res.write('data: ' + JSON.stringify({ ...meta, ...event }) + '\n\n');
  write({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
  write({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  if (metrics?.inputTokens != null && metrics.outputTokens != null) {
    write({
      choices: [],
      usage: {
        prompt_tokens: metrics.inputTokens,
        completion_tokens: metrics.outputTokens,
        total_tokens: metrics.inputTokens + metrics.outputTokens,
      },
    });
  }
  res.end('data: [DONE]\n\n');
}

export async function startRelay(infer = queryWithFallback) {
  const turns = new Map();
  const token = randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    if (
      req.method !== 'POST' ||
      req.url !== '/v1/chat/completions' ||
      req.headers.authorization !== 'Bearer ' + token
    ) {
      res.writeHead(403).end();
      return;
    }
    let turn;
    const disconnected = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) disconnected.abort();
    });
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4_000_000) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const { messages } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      turn = findTurn(messages, turns);
      if (!turn || turn.claimed || turn.signal.aborted) {
        res.writeHead(403).end();
        return;
      }
      turn.claimed = true;
      const signal = AbortSignal.any([turn.signal, disconnected.signal]);
      const result = await infer(turn.inference.route, messages, signal, turn.inference.progress, {
        question: turn.inference.question,
      });
      turn.inference.answerModel = result.model;
      turn.inference.vision = result.vision;
      completion(res, result.text, result.metrics);
    } catch (error) {
      if (!turn) {
        if (!res.destroyed) res.writeHead(400).end();
        return;
      }
      turn.error =
        error instanceof GuideError
          ? error
          : new GuideError(
              502,
              'provider_network',
              'The provider connection ended before the answer arrived.',
            );
      // Provider-specific errors go back to the app separately. They must never put the shared gateway identity on cooldown.
      completion(res, '{"error":"provider_request_failed"}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    token,
    url: 'http://127.0.0.1:' + server.address().port + '/v1',
    close: () => server.close(),
    register(inference, signal) {
      const nonce = randomBytes(16).toString('hex');
      const turn = { inference, signal, claimed: false, error: null };
      turns.set(nonce, turn);
      return { turn, instruction: '\n\nProxima transport ID: ' + nonce, release: () => turns.delete(nonce) };
    },
  };
}
