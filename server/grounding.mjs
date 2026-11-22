// The model can also elect to point for other questions. An explicit request makes placement part of the answer.
export function asksForMarker(question = '') {
  return /\b(?:mark|circle|star|highlight|outline|locate|pinpoint|point\s+(?:at|to|out)|show\s+me\s+(?:the|which|where)|where(?:'s|\s+(?:is|are))|which\s+(?:one|button|key|port))\b/i.test(question)
    || /\b(?:put|place|draw|add|set|drop)\b[\w -]{0,40}\b(?:dot|star|arrow|ring|marker|circle|pin|anchor)\b/i.test(question)
    || /标[记出]|圈[出一]|指出|在哪里|在哪[儿里]|標[記出]|圈起|在哪裡/.test(question);
}

export const boxDirections =
  'Find the particular object or part the current user wants to see in the actual image. ' +
  'Inspect its visible shape, markings and neighbors; for a small control, bound that individual control. ' +
  'Include a short label and bbox_2d [left, top, right, bottom] as four integers from 0 to 1000, relative to the whole image with origin at top left. ' +
  'If the target is absent, indistinguishable, or its location is known only from general knowledge, return null for both. Never guess a position.';

export function boxPoint(label, box) {
  if (typeof label !== 'string' || !label.trim() || label.length > 80 ||
      !Array.isArray(box) || box.length !== 4 ||
      !box.every((n) => Number.isInteger(n) && n >= 0 && n <= 1000)) return null;
  const [left, top, right, bottom] = box;
  if (right <= left || bottom <= top || (right <= 1 && bottom <= 1)) return null;
  return { label: label.trim(), x: (left + right) / 2000, y: (top + bottom) / 2000 };
}
