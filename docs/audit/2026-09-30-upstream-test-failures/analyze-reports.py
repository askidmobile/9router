#!/usr/bin/env python3
"""Build a compact, credential-free inventory from the captured Vitest reports.

Usage: python3 analyze-reports.py ORIGINAL_REPORT_DIR REPEAT_REPORT_DIR OUTPUT_DIR
The classification is the result of the source/runtime audit described in REPORT.md.
"""
import collections
import hashlib
import json
import pathlib
import re
import sys

original_dir, repeat_dir, output_dir = map(pathlib.Path, sys.argv[1:4])
output_dir.mkdir(parents=True, exist_ok=True)

CATEGORIES = {
    "stale_expectation": "Устаревшее ожидание контракта или политики",
    "invalid_mock": "Мок не соответствует действительному пути выполнения",
    "retired_transport": "Тест удалённого в fork транспорта CommandCode",
    "inverted_expected_failure": "it.fails стал красным после исправления поведения",
    "fixed_upstream_defect": "Реальный дефект upstream уже исправлен в fork",
    "usage_collision": "Потеря самостоятельных событий usage остаётся в fork",
    "disabled_feature": "Автоподбор Combo по web_search явно отключён",
    "external_live_failure": "Нестабильный внешний live endpoint MiMo",
}

NOTES = {
    "bugs-claudeCode-context.test.js": "tool_result image уже сохраняется; устарел модификатор it.fails, а не положительное утверждение.",
    "bugs-openai-bridge.test.js": "tool_result image уже сохраняется; it.fails ожидает ошибку и краснеет при корректном результате.",
    "bugs-toClaude-context.test.js": "Upstream теряет assistant.reasoning_content; текущий fork создаёт thinking block и сохраняет его после prepareClaudeRequest.",
    "bugs-gemini-cursor-commandcode.test.js": "Проверяется прежний /alpha/generate envelope CommandCode; этот транспорт отсутствует в fork.",
    "claude-kiro-direct.test.js": "Проверяется удалённый top-level systemPrompt и прежние thinking tags; инструкции теперь в userInputMessage.content, native effort проверяется отдельно.",
    "thinking-unified.test.js": "В upstream GLM-5.2 имеет неверную capability thinkingEffortSupported, поэтому запрошенный reasoning_effort исчезает; fork сохраняет low.",
    "claude-header-forwarding.test.js": "Тест ждёт вызов gotScraping, хотя текущий proxyAwareFetch использует native fetch.",
    "codex-image-fetch.test.js": "DNS мок возвращает один объект; SSRF guard вызывает lookup с all:true и ожидает массив адресов.",
    "combo-autoswitch.test.js": "Порядок списка сохраняется, но возвращается новая ссылка; поиск в auto-switch отдельно явно отключён.",
    "commandcode-to-openai.test.js": "Legacy NDJSON error event теперь выбрасывает исключение; fork использует OpenAI-compatible транспорт и удалил этот translator.",
    "cursor-models.test.js": "Мок global.fetch не перехватывает HTTP/2 Connect transport Cursor; fork мокает http2.",
    "db-concurrent.test.js": "SQL дедупликация сравнивает timestamp/provider/model/account/key/token counts без request identity. Разные запросы в одну миллисекунду схлопываются; уникальные модели в fork тестах обходят дефект.",
    "executor-const-guard.test.js": "Тест ожидает 6 retry attempts для Antigravity 429; registry задаёт 3.",
    "force-stream-config.test.js": "Мок headroom не экспортирует formatHeadroomSizeLog, который уже вызывает chatCore.",
    "image-fetch-hardening.test.js": "Мок DNS не соответствует lookup({all:true}); public PNG ошибочно отклоняется из-за формы мока.",
    "image-generation.test.js": "Тест жёстко задаёт header version 0.154.0; действительный CODEX_CLI_VERSION равен 0.155.0.",
    "kiro-external-idp.test.js": "Изменился порядок baseUrls: первым идёт q endpoint, codewhisperer остаётся fallback.",
    "kiro-terminal-integrity.test.js": "Настроены только два ответа fetch; новый failover выполняет дополнительные попытки, для которых мок возвращает undefined.",
    "mimo-free.live.test.js": "В сохранённом прогоне внешний chat endpoint вернул 400 вместо 200. Тест не был gated; fork включает его только при RUN_LIVE_TESTS=1.",
    "oauth-cursor-auto-import.test.js": "Тесты ждут прежние error messages, prepare().all(), fuzzy keys и отказ неизвестной платформе; route использует точные prepare().get(), несколько путей и manual fallback.",
    "openai-to-claude.test.js": "Arguments буферизуются и очищаются при finish_reason; fixture не отправляет terminal chunk.",
    "openai-to-commandcode.test.js": "Старый native CommandCode envelope и формат image blocks не используются в fork.",
    "openai-to-kiro.test.js": "Тесты читают отсутствующий systemPrompt и требуют прежние XML thinking tags; актуальный payload переносит инструкции в user content и использует model-specific native effort.",
    "opencode-free-tool-choice.test.js": "Executor теперь добавляет fingerprint tools даже к непустому набору tools; равенство массива один-в-один устарело, tool_choice auto сохраняется.",
    "opencode-muse-spark-thinking.test.js": "Исходные tools и отсутствие старого encrypted reasoning сохраняются; тест падает только из-за добавленных fingerprint tools.",
    "request-details-tab.test.js": "Fixture включает несуществующий enableObservability2 вместо enableObservability, поэтому ожидаемые request details не записываются.",
    "security-audit.test.js": "Upstream выдаёт полный фиктивный API key в ключах byApiKey. Fork хеширует ключи публичного объекта; runtime probe подтверждает отсутствие raw key в четырёх периодах.",
    "translator-helpers-edge.test.js": "Mid-conversation system text сохраняется в соседнем user turn ради стабильного prompt prefix, а не переносится в body.system.",
    "translator-request-normalization.test.js": "Несколько текстовых блоков остаются допустимым OpenAI content array; для raw NDJSON parseSSELine требуется явный FORMATS.OLLAMA.",
    "windsurf-executor.test.js": "Registry entry Windsurf скрыта upstream; executor работает самостоятельно и использует server.codeium.com вместо прежнего hostname.",
}


def load(folder, filename):
    path = folder / filename
    return json.loads(path.read_text()), {
        "filename": filename,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def short_path(name):
    normalized = name.replace("\\", "/")
    return "tests/" + normalized.split("/tests/", 1)[1]


def failed_tests(report):
    return {
        (short_path(file["name"]), case["fullName"]): case
        for file in report["testResults"]
        for case in file["assertionResults"]
        if case["status"] == "failed"
    }


def category(file, title):
    name = pathlib.Path(file).name
    if name in {"bugs-claudeCode-context.test.js", "bugs-openai-bridge.test.js"}:
        return "inverted_expected_failure"
    if name in {"bugs-toClaude-context.test.js", "thinking-unified.test.js", "security-audit.test.js"}:
        return "fixed_upstream_defect"
    if name in {"bugs-gemini-cursor-commandcode.test.js", "commandcode-to-openai.test.js", "openai-to-commandcode.test.js"}:
        return "retired_transport"
    if name in {"codex-image-fetch.test.js", "cursor-models.test.js", "force-stream-config.test.js", "image-fetch-hardening.test.js", "kiro-terminal-integrity.test.js"}:
        return "invalid_mock"
    if name == "db-concurrent.test.js":
        return "usage_collision"
    if name == "combo-autoswitch.test.js" and "web_search" in title:
        return "disabled_feature"
    if name == "mimo-free.live.test.js":
        return "external_live_failure"
    if name not in NOTES:
        raise ValueError("Unclassified file: " + file)
    return "stale_expectation"


upstream, upstream_source = load(original_dir, "upstream-tests.json")
pr, pr_source = load(original_dir, "pr-tests-final.json")
fork, fork_source = load(original_dir, "verified-tests.json")
original_failures, pr_failures = failed_tests(upstream), failed_tests(pr)
assert len(original_failures) == 85
assert original_failures.keys() == pr_failures.keys()

repeat_upstream, repeat_upstream_source = load(repeat_dir, "upstream.json")
repeat_pr, repeat_pr_source = load(repeat_dir, "pr.json")
repeat_fork, repeat_fork_source = load(repeat_dir, "fork.json")
repeat_failures, repeat_pr_failures = failed_tests(repeat_upstream), failed_tests(repeat_pr)
assert repeat_failures.keys() == repeat_pr_failures.keys()
assert len(repeat_failures) == 84
assert len(original_failures.keys() - repeat_failures.keys()) == 1
assert not (repeat_failures.keys() - original_failures.keys())
assert repeat_fork["success"] and repeat_fork["numFailedTests"] == 0

fork_files = {short_path(file["name"]): file for file in repeat_fork["testResults"]}
fork_cases = {
    (short_path(file["name"]), case["fullName"]): case
    for file in repeat_fork["testResults"] for case in file["assertionResults"]
}
inventory = []
for index, ((file, title), case) in enumerate(sorted(original_failures.items()), 1):
    kind = category(file, title)
    messages = "\n".join(case.get("failureMessages", []))
    match = re.search(re.escape(file) + r":(\d+):(\d+)", messages)
    fork_file = fork_files.get(file)
    fork_case = fork_cases.get((file, title))
    inventory.append({
        "id": index, "file": file, "test": title,
        "testLine": int(match.group(1)) if match else None,
        "originalError": messages.splitlines()[0] if messages else "",
        "category": kind, "categoryRu": CATEGORIES[kind],
        "reason": NOTES[pathlib.Path(file).name],
        "forkExactCaseStatus": fork_case["status"] if fork_case else "no_exact_name",
        "forkFileStatus": fork_file["status"] if fork_file else "not_present",
        "repeatedWithSameName": (file, title) in repeat_failures,
    })

category_counts = collections.Counter(case["category"] for case in inventory)
assert category_counts == {
    "stale_expectation": 63, "invalid_mock": 8, "retired_transport": 4,
    "inverted_expected_failure": 2, "fixed_upstream_defect": 3,
    "usage_collision": 3, "disabled_feature": 1, "external_live_failure": 1,
}, category_counts

suite_errors = [{"file": short_path(file["name"]), "error": file.get("message", "")}
                for file in upstream["testResults"] if file["status"] == "failed"
                and not any(case["status"] == "failed" for case in file["assertionResults"])]
assert len(suite_errors) == 6


def counts(report):
    return {"total": report["numTotalTests"], "passedIncludingExpectedFailures": report["numPassedTests"],
            "failedAssertions": report["numFailedTests"], "skipped": report["numPendingTests"],
            "files": len(report["testResults"]), "success": report["success"]}


summary = {
    "date": "2026-09-30", "upstreamRevision": "f01fb909e37189008080632ddaf404f096345cde",
    "prRevision": "a369be29cce1f9518bef46a26382259fbab9e1e0",
    "forkRevision": "e58eedbc865ed3ac0d33865fb35aa46c6fbcb7a0",
    "nodeVersion": "v26.7.0", "vitestVersion": "4.1.10",
    "sameOriginalFailureNames": True, "sameRepeatFailureNames": True,
    "excludedOriginalFailure": next(iter(original_failures.keys() - repeat_failures.keys())),
    "categories": [{"id": kind, "label": CATEGORIES[kind], "count": category_counts[kind]} for kind in CATEGORIES],
    "original": {"upstream": counts(upstream), "pr": counts(pr), "fork": counts(fork)},
    "repeat": {"upstream": counts(repeat_upstream), "pr": counts(repeat_pr), "fork": counts(repeat_fork)},
    "sources": [upstream_source, pr_source, fork_source, repeat_upstream_source, repeat_pr_source, repeat_fork_source],
    "suiteErrorsBeyond85": suite_errors,
    "nativeNodeTestWithAliases": {"tests": 38, "passed": 37, "failed": 1,
                                  "failure": "kimchi.category expects oauth, actual freeTier"},
    "forkExpectedFailureCases": 13,
    "runtimeProbes": {name: json.loads((repeat_dir / ("probe-" + name + ".json")).read_text())
                      for name in ["upstream", "fork"]},
    "runs": json.loads((repeat_dir / "runs.json").read_text()),
}
(output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
(output_dir / "failures.json").write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"failures": len(inventory), "filesWithFailedAssertions": len({case["file"] for case in inventory}),
                  "categories": dict(category_counts), "suiteErrorsBeyond85": len(suite_errors)}, ensure_ascii=False))
