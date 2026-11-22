import { randomUUID } from 'node:crypto';
import { selectExcerpts } from '../web/manual.js';
import { buildTurn, parseTurn, GuideError } from './guidance.mjs';
import { findManual, lookupRequest } from './manual-search.mjs';

function passages(documents, question, topic) {
  return documents.map((doc, i) => {
    const selections = selectExcerpts({ name: doc.title, chunks: doc.chunks }, question, topic);
    return {
      id: 'S' + (i + 1),
      device: doc.device,
      title: doc.title,
      excerpts: (selections.length ? selections : doc.chunks.slice(0, 1)).map((c) => c.text),
    };
  });
}

// Each client keeps only an opaque handle. Evidence belongs to one scene and expires from memory.
export function createGuide({ runGateway, search = findManual }) {
  const contexts = new Map();
  function remember(documents) {
    for (const [key, entry] of contexts) if (entry.expires < Date.now()) contexts.delete(key);
    if (contexts.size >= 64) contexts.delete(contexts.keys().next().value);
    const id = randomUUID();
    contexts.set(id, { documents, expires: Date.now() + 60 * 60 * 1000 });
    return id;
  }
  return async function guide(frame, signal, progress = () => {}) {
    let contextId = frame.contextId;
    const previous = contexts.get(contextId);
    let documents = previous && previous.expires > Date.now() ? previous.documents : [];
    if (!documents.length) contextId = null;
    let refs = passages(documents, frame.question, frame.history.at(-1)?.question || '');
    const turn = async (status) =>
      parseTurn(
        await runGateway(buildTurn(frame, { references: refs, lookupStatus: status }), signal),
        frame,
      );
    let result = await turn('allowed');
    let lookupStatus = 'direct';
    if (result.lookup) {
      const plan = lookupRequest(result.lookup);
      let found = [];
      lookupStatus = 'no_match';
      if (plan) {
        progress('searching', plan.device);
        try {
          found = await search(plan, signal);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          lookupStatus = 'unavailable';
        }
      }
      if (found.length) {
        // A different identified device starts its own evidence set.
        const relevant = documents.filter((d) => d.device.toLowerCase() === plan.device.toLowerCase());
        const urls = new Set(found.map((d) => d.url));
        documents = [...found, ...relevant.filter((d) => !urls.has(d.url))].slice(0, 4);
        contextId = remember(documents);
        refs = passages(documents, plan.topic, frame.question);
        lookupStatus = 'found';
      } else {
        refs = [];
      }
      progress('answering', lookupStatus);
      try {
        result = await turn(lookupStatus);
      } catch (error) {
        if (error instanceof GuideError && contextId) error.contextId = contextId;
        throw error;
      }
      if (result.lookup)
        throw new GuideError(
          502,
          'invalid_reply',
          'Kimi could not finish the answer. Try a more specific question.',
        );
    }
    const { sourceIds, ...reply } = result;
    const cited = refs.filter((r) => sourceIds.includes(r.id));
    const shown = cited.length ? cited : lookupStatus === 'found' ? refs : [];
    const sources = shown.map((r) => {
      const doc = documents[refs.indexOf(r)];
      return { title: doc.title, url: doc.url, device: doc.device };
    });
    return { ...reply, contextId, sources, lookupStatus };
  };
}
