"""Tests for scripts/elevenlabs-text-to-speech-generator.py (standard library only).

No test reaches the network or imports the elevenlabs SDK; provider calls go
through an in-memory fake client.

Run: python -m pytest scripts/tests/test_elevenlabs_text_to_speech_generator.py
"""
import importlib.util
import io
import os
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "elevenlabs_tts_generator", SCRIPTS / "elevenlabs-text-to-speech-generator.py"
)
tts = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tts)


class FakeTextToSpeech:
    def __init__(self, chunks=(b"ID3", b"audio"), error=None):
        self.calls = []
        self._chunks = chunks
        self._error = error

    def _respond(self, kind, kwargs):
        self.calls.append((kind, kwargs))
        if self._error:
            raise self._error
        return iter(self._chunks)

    def convert(self, **kwargs):
        return self._respond("convert", kwargs)

    def stream(self, **kwargs):
        return self._respond("stream", kwargs)


def fake_client(voices=(), **tts_kwargs):
    listed = [SimpleNamespace(name=name, voice_id=voice_id) for name, voice_id in voices]
    return SimpleNamespace(
        text_to_speech=FakeTextToSpeech(**tts_kwargs),
        voices=SimpleNamespace(get_all=lambda: SimpleNamespace(voices=listed)),
    )


class BuildRequestTest(unittest.TestCase):
    def test_v4_sends_only_supported_settings(self):
        request, warnings = tts.build_request(
            "eleven_v4", "[whispers] Hello.", {"stability": 0.4, "similarity_boost": 0.8}
        )
        self.assertEqual(request["voice_settings"], {"stability": 0.4, "similarity_boost": 0.8})
        self.assertEqual(request["model_id"], "eleven_v4")
        self.assertEqual(warnings, [])

    def test_v4_rejects_style_and_speed_with_flag_names(self):
        for setting, flag in (("style", "--style"), ("speed", "--speed"),
                              ("use_speaker_boost", "--speaker-boost")):
            with self.subTest(setting=setting):
                with self.assertRaises(tts.RequestError) as ctx:
                    tts.build_request("eleven_v4", "Hi.", {setting: 1.0})
                self.assertIn(flag, str(ctx.exception))
                self.assertIn("audio tags", str(ctx.exception))

    def test_v2_models_accept_full_setting_set(self):
        settings = {"stability": 0.5, "similarity_boost": 0.75, "style": 0.2, "speed": 1.1,
                    "use_speaker_boost": True}
        request, _ = tts.build_request("eleven_multilingual_v2", "Hi.", settings)
        self.assertEqual(request["voice_settings"], settings)

    def test_omitted_settings_are_not_sent(self):
        request, _ = tts.build_request("eleven_v4", "Hi.", {})
        self.assertNotIn("voice_settings", request)

    def test_break_tags_rejected_on_v3_and_v4_but_allowed_on_v2(self):
        text = 'Wait. <break time="1.0s" /> Go.'
        for model in ("eleven_v4", "eleven_v3"):
            with self.subTest(model=model):
                with self.assertRaisesRegex(tts.RequestError, "break"):
                    tts.build_request(model, text, {})
        request, _ = tts.build_request("eleven_flash_v2_5", text, {})
        self.assertEqual(request["text"], text)

    def test_v4_turbo_is_not_sent_to_http_endpoint(self):
        with self.assertRaisesRegex(tts.RequestError, "WebSocket"):
            tts.build_request("eleven_v4_turbo", "Hi.", {})

    def test_language_code_validation(self):
        request, _ = tts.build_request("eleven_v4", "Bonjour.", {}, language_code="fr")
        self.assertEqual(request["language_code"], "fr")
        with self.assertRaisesRegex(tts.RequestError, "language-code"):
            tts.build_request("eleven_multilingual_v2", "Hola.", {}, language_code="es")
        with self.assertRaisesRegex(tts.RequestError, "lowercase language code"):
            tts.build_request("eleven_v4", "Hi.", {}, language_code="English")

    def test_stitching_and_optional_fields_pass_through(self):
        request, _ = tts.build_request(
            "eleven_v4", "Part two.", {}, previous_text="Part one.", next_text="Part three.",
            text_normalization="on", output_format="mp3_44100_128",
        )
        self.assertEqual(request["previous_text"], "Part one.")
        self.assertEqual(request["next_text"], "Part three.")
        self.assertEqual(request["apply_text_normalization"], "on")
        self.assertEqual(request["output_format"], "mp3_44100_128")

    def test_stitching_rejected_on_v3(self):
        for kwargs in ({"previous_text": "Before."}, {"next_text": "After."}):
            with self.subTest(**kwargs):
                with self.assertRaisesRegex(tts.RequestError, "stitching"):
                    tts.build_request("eleven_v3", "Middle.", {}, **kwargs)

    def test_unknown_model_warns_and_sends_only_passed_settings(self):
        request, warnings = tts.build_request("eleven_future_v9", "Hi.", {"style": 0.3})
        self.assertEqual(request["voice_settings"], {"style": 0.3})
        self.assertEqual(len(warnings), 1)
        self.assertIn("eleven_future_v9", warnings[0])

    def test_out_of_range_and_empty_inputs_fail(self):
        with self.assertRaisesRegex(tts.RequestError, "--stability"):
            tts.build_request("eleven_v4", "Hi.", {"stability": 1.5})
        with self.assertRaisesRegex(tts.RequestError, "--speed"):
            tts.build_request("eleven_v3", "Hi.", {"speed": 0})
        with self.assertRaisesRegex(tts.RequestError, "empty"):
            tts.build_request("eleven_v4", "   ", {})


class SynthesizeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name) / "out.mp3"

    def test_writes_audio_and_forwards_request(self):
        client = fake_client()
        request, _ = tts.build_request("eleven_v4", "Hi.", {"stability": 0.5})
        tts.synthesize(client, "voice123", request, self.out)
        self.assertEqual(self.out.read_bytes(), b"ID3audio")
        if os.name == "posix":
            umask = os.umask(0)
            os.umask(umask)
            self.assertEqual(self.out.stat().st_mode & 0o777, 0o666 & ~umask)
        kind, kwargs = client.text_to_speech.calls[0]
        self.assertEqual(kind, "convert")
        self.assertEqual(kwargs["voice_id"], "voice123")
        self.assertEqual(kwargs["voice_settings"], {"stability": 0.5})

    def test_stream_uses_stream_method(self):
        client = fake_client()
        request, _ = tts.build_request("eleven_v4", "Hi.", {})
        tts.synthesize(client, "voice123", request, self.out, stream=True)
        self.assertEqual(client.text_to_speech.calls[0][0], "stream")

    def test_provider_error_leaves_no_partial_file(self):
        client = fake_client(error=RuntimeError("422 invalid"))
        request, _ = tts.build_request("eleven_v4", "Hi.", {})
        with self.assertRaisesRegex(RuntimeError, "422"):
            tts.synthesize(client, "voice123", request, self.out)
        self.assertFalse(self.out.exists())

    def test_failed_call_keeps_existing_output_and_leaves_no_temp_file(self):
        self.out.write_bytes(b"previous take")
        client = fake_client(error=RuntimeError("500"))
        request, _ = tts.build_request("eleven_v4", "Hi.", {})
        with self.assertRaises(RuntimeError):
            tts.synthesize(client, "voice123", request, self.out)
        self.assertEqual(self.out.read_bytes(), b"previous take")
        self.assertEqual(sorted(p.name for p in Path(self.tmp.name).iterdir()), ["out.mp3"])

    def test_empty_audio_is_an_error(self):
        client = fake_client(chunks=())
        request, _ = tts.build_request("eleven_v4", "Hi.", {})
        with self.assertRaisesRegex(RuntimeError, "no audio"):
            tts.synthesize(client, "voice123", request, self.out)
        self.assertFalse(self.out.exists())


class VoiceAndCliTest(unittest.TestCase):
    def test_resolve_voice_by_id_name_and_premade_fallback(self):
        client = fake_client(voices=[("Narrator", "abcdefghij0123456789")])
        self.assertEqual(tts.resolve_voice_id(client, "JBFqnCBsd6RMkjVDRZzb"), "JBFqnCBsd6RMkjVDRZzb")
        self.assertEqual(tts.resolve_voice_id(client, "narrator"), "abcdefghij0123456789")
        self.assertEqual(tts.resolve_voice_id(client, "Rachel"), "21m00Tcm4TlvDq8ikWAM")
        with self.assertRaisesRegex(tts.RequestError, "not found"):
            tts.resolve_voice_id(client, "Nobody")

    def test_requested_settings_collects_only_explicit_flags(self):
        args = tts.parse_args(["Hi", "--stability", "0.3", "--no-speaker-boost"])
        self.assertEqual(tts.requested_settings(args), {"stability": 0.3, "use_speaker_boost": False})
        defaults = tts.parse_args(["Hi"])
        self.assertEqual(defaults.model, "eleven_v4")
        self.assertEqual(tts.requested_settings(defaults), {})

    def test_cli_rejects_unsupported_setting_before_any_api_access(self):
        stderr = io.StringIO()
        with mock.patch.object(tts, "load_env") as load_env, redirect_stderr(stderr):
            code = tts.main(["Hi", "-m", "eleven_v4", "--speed", "1.1"])
        self.assertEqual(code, 2)
        load_env.assert_not_called()
        self.assertIn("--speed", stderr.getvalue())

    def test_cli_reports_missing_api_key(self):
        stderr = io.StringIO()
        with mock.patch.object(tts, "load_env", return_value=None), redirect_stderr(stderr):
            code = tts.main(["Hi"])
        self.assertEqual(code, 1)
        self.assertIn("ELEVENLABS_API_KEY", stderr.getvalue())

    def test_cli_reads_utf8_script_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = Path(tmp) / "script.txt"
            script.write_text("[sighs] Café… again.", encoding="utf-8")
            args = tts.parse_args(["-f", os.fspath(script)])
            self.assertEqual(tts.read_text(args), "[sighs] Café… again.")


if __name__ == "__main__":
    unittest.main()
