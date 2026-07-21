export function buildVoiceboxGenerationPayload({ profileId, text, language }) {
  return {
    profile_id: profileId,
    text,
    language,
    model_size: '1.7B',
    // ICL mode can echo the reference recording before the requested text.
    x_vector_only_mode: true,
  };
}

export function buildVoiceboxGenerationRequest({ profileId, text, language }) {
  return {
    endpoint: '/generate/stream',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildVoiceboxGenerationPayload({ profileId, text, language })),
  };
}
