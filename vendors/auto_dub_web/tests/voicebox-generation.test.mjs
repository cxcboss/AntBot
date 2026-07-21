import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildVoiceboxGenerationPayload,
  buildVoiceboxGenerationRequest,
} from '../voicebox-generation.mjs';

test('video dubbing disables ICL reference audio conditioning', () => {
  const payload = buildVoiceboxGenerationPayload({
    profileId: 'profile-1',
    text: '新的配音内容',
    language: 'zh',
  });

  assert.deepEqual(payload, {
    profile_id: 'profile-1',
    text: '新的配音内容',
    language: 'zh',
    model_size: '1.7B',
    x_vector_only_mode: true,
  });
});

test('video dubbing requests streamed wav generation instead of persistent history', () => {
  const request = buildVoiceboxGenerationRequest({
    profileId: 'profile-1',
    text: '剪辑配音',
    language: 'zh',
  });

  assert.equal(request.endpoint, '/generate/stream');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.body), {
    profile_id: 'profile-1',
    text: '剪辑配音',
    language: 'zh',
    model_size: '1.7B',
    x_vector_only_mode: true,
  });
});
