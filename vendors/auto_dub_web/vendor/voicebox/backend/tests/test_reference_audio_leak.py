import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from backend import models, profiles
from backend.backends.pytorch_backend import PyTorchTTSBackend


class _SampleQuery:
    def filter_by(self, **_kwargs):
        return self

    def all(self):
        return [SimpleNamespace(audio_path="reference.wav", reference_text="参考文本")]


class _Database:
    def query(self, _model):
        return _SampleQuery()


class _QwenModel:
    def __init__(self):
        self.x_vector_only_mode = None
        self.ref_text = "unset"

    def create_voice_clone_prompt(self, **kwargs):
        self.x_vector_only_mode = kwargs["x_vector_only_mode"]
        self.ref_text = kwargs["ref_text"]
        return ["prompt"]


class ReferenceAudioLeakTests(unittest.TestCase):
    def test_generation_request_accepts_x_vector_only_mode(self):
        request = models.GenerationRequest(
            profile_id="profile-1",
            text="新的配音内容",
            language="zh",
            x_vector_only_mode=True,
        )

        self.assertTrue(request.x_vector_only_mode)

    def test_profile_prompt_forwards_x_vector_only_mode(self):
        tts_model = SimpleNamespace(
            create_voice_prompt=AsyncMock(return_value=(["prompt"], False)),
        )

        with patch.object(profiles, "get_tts_model", return_value=tts_model):
            prompt = asyncio.run(
                profiles.create_voice_prompt_for_profile(
                    "profile-1",
                    _Database(),
                    x_vector_only_mode=True,
                )
            )

        self.assertEqual(prompt, ["prompt"])
        tts_model.create_voice_prompt.assert_awaited_once_with(
            "reference.wav",
            "参考文本",
            use_cache=True,
            x_vector_only_mode=True,
        )

    def test_pytorch_prompt_uses_mode_specific_cache_and_qwen_option(self):
        backend = PyTorchTTSBackend.__new__(PyTorchTTSBackend)
        backend.model = _QwenModel()
        backend.load_model_async = AsyncMock()

        with (
            patch(
                "backend.backends.pytorch_backend.get_cache_key",
                return_value="speaker-only-cache-key",
            ) as get_cache_key,
            patch(
                "backend.backends.pytorch_backend.get_cached_voice_prompt",
                return_value=None,
            ),
            patch("backend.backends.pytorch_backend.cache_voice_prompt") as cache_voice_prompt,
        ):
            prompt, was_cached = asyncio.run(
                backend.create_voice_prompt(
                    "reference.wav",
                    "参考文本",
                    x_vector_only_mode=True,
                )
            )

        self.assertEqual(prompt, ["prompt"])
        self.assertFalse(was_cached)
        self.assertTrue(backend.model.x_vector_only_mode)
        self.assertIsNone(backend.model.ref_text)
        get_cache_key.assert_called_once_with(
            "reference.wav",
            "参考文本",
            x_vector_only_mode=True,
        )
        cache_voice_prompt.assert_called_once_with("speaker-only-cache-key", ["prompt"])


if __name__ == "__main__":
    unittest.main()
