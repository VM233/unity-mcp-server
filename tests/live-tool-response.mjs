import assert from "node:assert/strict";

export function getStructuredEnvelope(response, label = "tool response",
  { expectSuccess = true } = {}) {
  assert.ok(response?.structuredContent &&
    typeof response.structuredContent === "object" &&
    !Array.isArray(response.structuredContent),
  `${label}: response did not contain structuredContent: ${JSON.stringify(response)}`);

  const text = response.content?.find((block) => block.type === "text")?.text || "";
  assert.ok(text, `${label}: response did not contain a human-readable text summary`);
  assert.doesNotMatch(text.trimStart(), /^[{[]/,
    `${label}: public text content duplicated the structured payload`);

  if (expectSuccess) {
    assert.equal(response.isError, undefined,
      `${label}: successful response was marked as an MCP error: ${JSON.stringify(response)}`);
    assert.equal(response.structuredContent.success, true,
      `${label}: tool returned a structured failure: ` +
      JSON.stringify(response.structuredContent));
  }

  return response.structuredContent;
}

export function getStructuredResult(response, label = "tool response") {
  return getStructuredEnvelope(response, label).result;
}

export function getStructuredFailure(response, label = "tool response") {
  const envelope = getStructuredEnvelope(response, label, { expectSuccess: false });
  assert.equal(response.isError, true,
    `${label}: structured failure was not marked as an MCP error`);
  assert.equal(envelope.success, false,
    `${label}: expected a structured failure: ${JSON.stringify(envelope)}`);
  assert.ok(envelope.errorCode && envelope.error,
    `${label}: structured failure omitted its code or message: ${JSON.stringify(envelope)}`);
  return envelope;
}
