import { AppError } from './domain.mjs';

export function inferenceError(code) {
  if (['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable'].includes(code)) {
    return new AppError('ChatGPT plan usage is unavailable or its limit was reached. Open Manage usage in Connections to review your limits.', 429);
  }
  return new AppError('The AI request did not complete. Your notes are preserved; please retry.', 502);
}

export async function readCompletedResponse(response) {
  if (!response.body) throw new AppError('The AI provider returned an empty stream.', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', eventData = [], completed = null, received = 0;
  function dispatch() {
    if (!eventData.length) return;
    const raw = eventData.join('\n'); eventData = [];
    if (raw === '[DONE]') return;
    let event;
    try { event = JSON.parse(raw); } catch { throw new AppError('The AI provider returned an invalid stream.', 502); }
    if (event.type === 'response.failed' || event.type === 'error') throw inferenceError(event.response?.error?.code ?? event.error?.code ?? event.code);
    if (event.type === 'response.incomplete') throw new AppError('The AI draft was incomplete. Shorten the notes and retry.', 502);
    if (event.type === 'response.completed') completed = event.response;
  }
  function consume(final = false) {
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
      if (!line) dispatch();
      else if (line.startsWith('data:')) eventData.push(line.slice(5).replace(/^ /, ''));
    }
    if (final) { if (buffer.startsWith('data:')) eventData.push(buffer.slice(5).replace(/^ /, '')); buffer = ''; dispatch(); }
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > 2000000) throw new AppError('The AI response exceeded the draft size limit.', 502);
      buffer += decoder.decode(value, { stream: true }); consume();
    }
    buffer += decoder.decode(); consume(true);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof AppError ? error : new AppError('The AI stream was interrupted. Your notes are preserved; please retry.', 502);
  } finally { reader.releaseLock(); }
  if (!completed || completed.status !== 'completed') throw new AppError('The AI stream ended before completion. Please retry.', 502);
  return completed;
}
