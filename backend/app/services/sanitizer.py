"""Best-effort secret redaction for captured LLM payloads.

Default redaction is conservative — we'd rather over-redact than persist a
real key. PLAN.md Fase 4 defines the privacy modes; this module is the
implementation hook for `sanitized_payload`.
"""
from __future__ import annotations

import re

_REPLACEMENT = "[REDACTED]"

# Order matters: longer / more specific patterns first.
_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # JWT (3 base64url segments separated by `.`)
    (re.compile(r"eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}"), _REPLACEMENT),
    # Bearer tokens / Authorization: Bearer XXX
    (re.compile(r"(?i)(authorization\s*:\s*bearer\s+)[^\s\"']+"), r"\1" + _REPLACEMENT),
    # AWS-style access keys
    (re.compile(r"AKIA[0-9A-Z]{16}"), _REPLACEMENT),
    # Google API keys
    (re.compile(r"AIza[0-9A-Za-z_-]{35}"), _REPLACEMENT),
    # OpenAI keys
    (re.compile(r"sk-[A-Za-z0-9_-]{20,}"), _REPLACEMENT),
    # Anthropic keys
    (re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"), _REPLACEMENT),
    # Generic "api_key": "..." / "apikey": "..." / "secret": "..."
    (
        re.compile(r"(?i)(\"(?:api[_-]?key|secret|token|password)\"\s*:\s*\")[^\"]+(\")"),
        r"\1" + _REPLACEMENT + r"\2",
    ),
    # `KEY=value` in env-style lines (best effort)
    (
        re.compile(
            r"(?im)^\s*(API_KEY|SECRET|TOKEN|PASSWORD|JWT|BEARER|ACCESS_TOKEN|REFRESH_TOKEN)\s*=\s*\S+"
        ),
        r"\1=" + _REPLACEMENT,
    ),
    # PEM-encoded private keys (RSA, OpenSSH, EC, PGP)
    (
        re.compile(
            r"-----BEGIN[ A-Z]+PRIVATE KEY[ A-Z]*-----[\s\S]+?-----END[ A-Z]+PRIVATE KEY[ A-Z]*-----"
        ),
        _REPLACEMENT,
    ),
    # GitHub PAT (classic + fine-grained)
    (re.compile(r"\bghp_[A-Za-z0-9]{30,}\b"), _REPLACEMENT),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{40,}\b"), _REPLACEMENT),
    # Slack tokens
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"), _REPLACEMENT),
    # Cookies "set-cookie: name=value" o "Cookie: ..."
    (
        re.compile(r"(?i)(set-cookie\s*:\s*)[^\r\n]+"),
        r"\1" + _REPLACEMENT,
    ),
    (
        re.compile(r"(?i)(cookie\s*:\s*)[^\r\n]+"),
        r"\1" + _REPLACEMENT,
    ),
    # Connection strings con password embebido: postgres://user:pass@host/db
    (
        re.compile(r"((?:postgres|mysql|mongodb|redis)(?:\+\w+)?://[^:\s]+:)[^@\s]+@"),
        r"\1" + _REPLACEMENT + "@",
    ),
]


def sanitize(text: str | None) -> str | None:
    if not text:
        return text
    out = text
    for pattern, replacement in _PATTERNS:
        out = pattern.sub(replacement, out)
    return out


def estimate_chars(text: str | None) -> int:
    return len(text) if text else 0
