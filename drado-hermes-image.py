"""Use Hermes' native ChatGPT image provider; stdout is only the bridge result."""
import contextlib
import importlib
import io
import json
import re
import sys


def failure(code, *, module=None, status=None):
    result = {"ok": False, "error": code}
    if module and re.fullmatch(r"[A-Za-z0-9_.-]{1,120}", module):
        result["module"] = module
    if status and re.fullmatch(r"\d{3}", str(status)):
        result["status"] = int(status)
    # Only structured diagnostics cross the bridge; never raw provider bodies or tokens.
    print(json.dumps(result), file=sys.__stdout__)


def main():
    payload = json.load(sys.stdin)
    # Imports and provider diagnostics must not corrupt the stdout protocol.
    with contextlib.redirect_stdout(sys.stderr):
        # Hermes' launcher uses a bare managed Python. Its packages live in a
        # separately selected environment, activated by this bootstrap import.
        # Match the published launcher before importing any third-party package.
        sys._hermes_pin_default_home = True
        import hermes_bootstrap  # noqa: F401

        from PIL import Image, ImageOps
        import base64

        plugin = importlib.import_module("plugins.image_gen.openai-codex")
        ratio = payload["aspectRatio"]
        width, height = map(int, ratio.split(":"))
        # HD output only, including legacy 2K requests from older clients.
        size = {"9:16": "576x1024", "16:9": "1024x576", "1:1": "1024x1024", "4:3": "1024x768", "3:4": "768x1024"}[ratio]
        requested_target = tuple(map(int, size.split("x")))
        # Isolated process override: never rewrite Hermes' global configuration.
        plugin.size_for = lambda _aspect: size
        result = plugin.OpenAICodexImageGenProvider().generate(
            prompt=payload["prompt"],
            aspect_ratio="portrait" if width < height else "landscape" if width > height else "square",
            reference_image_urls=payload.get("references") or None,
        )
        if not result.get("success"):
            status = re.search(r"\bHTTP\s+(\d{3})\b", str(result.get("error", "")))
            failure(result.get("error_type", "provider_error"), status=status.group(1) if status else None)
            return
        with Image.open(result["image"]) as image:
            image = ImageOps.exif_transpose(image).convert("RGB")
            # Native ChatGPT may return a different size. Keep saved frame metadata exact.
            scale = min(image.width / width, image.height / height)
            target = requested_target or (max(1, int(scale) * width), max(1, int(scale) * height))
            upscaled = image.width < target[0] or image.height < target[1]
            image = ImageOps.fit(image, target, method=Image.Resampling.LANCZOS)
            output = io.BytesIO()
            image.save(output, format="PNG")
            data = base64.b64encode(output.getvalue()).decode("ascii")
    print(json.dumps({"ok": True, "data": data, "mimeType": "image/png", "width": target[0], "height": target[1], "upscaled": upscaled}))


if __name__ == "__main__":
    try:
        main()
    except ModuleNotFoundError as error:
        failure("missing_dependency", module=error.name)
        sys.exit(1)
    except ImportError:
        failure("import_error")
        sys.exit(1)
    except Exception:
        failure("bridge_error")
        sys.exit(1)
