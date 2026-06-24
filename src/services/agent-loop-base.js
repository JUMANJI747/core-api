'use strict';

// Wspólna pętla wykonania sub-agentów (accounting/communication, PL/ES).
// Wcześniej każdy z 4 agentów miał własną, niemal identyczną kopię pętli
// tool_use (~35-50 linii). Logika biznesowa (prompty, definicje tooli,
// endpointy, stawki podatku, intencje) ZOSTAJE w każdym agencie — tutaj jest
// tylko mechanika pętli. Różnice per-agent obsługiwane przez opcjonalne hooki:
//   - getSystem()/getTools(): accounting buduje je per-iterację (podstawia daty),
//     communication podaje statyczne.
//   - onToolUse(tu, ctx): mutacja inputu toola przed wykonaniem (np. override
//     języka oferty w communication-PL).
//   - onToolResult(name, result, ctx): może zwrócić nazwę toola do WYMUSZENIA
//     na następnej iteracji (np. cs_invoice_confirm po cs_get_context w ES).
//   - logResult: czy logować skrócony wynik toola (accounting-ES to robił).

const { sanitizeAssistantContent } = require('./agent-runtime');

// Wykrywa „API Anthropic przeciążone" (HTTP 529 / 503 / overloaded_error). Po
// wyczerpaniu retry SDK chcemy zwrócić CZYTELNY komunikat, a nie generyczny błąd,
// który mistrz n8n zamienia w bezsensowną odpowiedź — i nikt nie wie, że to overload.
function isOverloadError(e) {
  if (!e) return false;
  const status = e.status || (e.response && e.response.status);
  if (status === 529 || status === 503 || status === 429) return true;
  const type = (e.error && e.error.type) || (e.body && e.body.error && e.body.error.type);
  if (type === 'overloaded_error' || type === 'rate_limit_error') return true;
  return /overloaded|rate.?limit|too many requests/i.test(e.message || '');
}
const OVERLOAD_TEXT = '⚠ Asystent chwilowo niedostępny — API Anthropic jest przeciążone (overloaded). Spróbuj ponownie za kilkadziesiąt sekund. (To NIE błąd danych — sam request był poprawny.)';

// Prompt caching (Anthropic) — duży, powtarzalny prefiks (system + definicje
// narzędzi) cache'ujemy, żeby kolejne wywołania w pętli i kolejne rozmowy
// trafiały w cache zamiast płacić za pełny prefiks (oszczędność ~do 56%).
// cache_control na OSTATNIM bloku system i OSTATNIM toolu = 2 breakpointy.
function cacheSystem(system) {
  if (!system) return system;
  if (typeof system === 'string') {
    return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }
  if (Array.isArray(system) && system.length) {
    const copy = system.map(b => ({ ...b }));
    copy[copy.length - 1] = { ...copy[copy.length - 1], cache_control: { type: 'ephemeral' } };
    return copy;
  }
  return system;
}
function cacheTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return tools;
  const copy = tools.map(t => ({ ...t }));
  copy[copy.length - 1] = { ...copy[copy.length - 1], cache_control: { type: 'ephemeral' } };
  return copy;
}

async function runAgentLoop({
  anthropic,
  model,
  messages,
  getSystem,
  getTools,
  firstToolChoice = null,
  executeTool,
  ctx = {},
  logPrefix = '[agent]',
  maxIter = 5,
  maxTokens = 2048,
  onToolUse = null,
  onToolResult = null,
  logResult = false,
}) {
  try {
  let response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: cacheSystem(getSystem()),
    tools: cacheTools(getTools()),
    tool_choice: firstToolChoice ? { type: 'tool', name: firstToolChoice } : { type: 'auto' },
    messages,
  });

  let iterations = 0;
  // Wyłapujemy previewId z wyniku narzędzia preview (FV/WZ) — front pokaże guzik
  // "Akceptuj", który woła confirm-endpoint WPROST (bez Anthropic). Confirm nie
  // zwraca previewId, więc po potwierdzeniu zostaje null.
  let pendingPreview = null;
  while (response.stop_reason === 'tool_use' && iterations < maxIter) {
    iterations++;
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResultBlocks = [];
    let nextForcedTool = null;
    for (const tu of toolUseBlocks) {
      if (onToolUse) onToolUse(tu, ctx);
      console.log(`${logPrefix} tool_use: ${tu.name}`, JSON.stringify(tu.input).slice(0, 300));
      const result = await executeTool(tu.name, tu.input, ctx);
      if (result && result.previewId) pendingPreview = { tool: tu.name, previewId: result.previewId };
      if (logResult) console.log(`${logPrefix} tool_result ${tu.name}:`, JSON.stringify(result).slice(0, 400));
      if (onToolResult) {
        const forced = onToolResult(tu.name, result, ctx);
        if (forced) nextForcedTool = forced;
      }
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: 'assistant', content: sanitizeAssistantContent(response.content) });
    messages.push({ role: 'user', content: toolResultBlocks });

    response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: cacheSystem(getSystem()),
      tools: cacheTools(getTools()),
      tool_choice: nextForcedTool ? { type: 'tool', name: nextForcedTool } : { type: 'auto' },
      messages,
    });
  }

  // Laczymy WSZYSTKIE bloki tekstowe (model czasem rozbija odpowiedz na kilka).
  // Wczesniej brano tylko pierwszy — gubilo to dalsze fragmenty.
  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
  return { text, iterations, stopReason: response.stop_reason, pendingPreview };
  } catch (e) {
    if (isOverloadError(e)) {
      console.warn(`${logPrefix} Anthropic OVERLOADED po retry:`, e.status || e.message);
      return { text: OVERLOAD_TEXT, overloaded: true, iterations: 0, stopReason: 'overloaded', pendingPreview: null };
    }
    throw e; // realne błędy nadal się propagują
  }
}

module.exports = { runAgentLoop, cacheSystem, cacheTools, isOverloadError, OVERLOAD_TEXT };
